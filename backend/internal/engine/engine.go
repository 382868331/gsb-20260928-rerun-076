// Package engine executes mock requests for a scenario.
package engine

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"mockplatform/internal/expr"
	"mockplatform/internal/model"
	"mockplatform/internal/store"
)

type Engine struct {
	store *store.Store
	mu    sync.Mutex
}

func New(st *store.Store) *Engine { return &Engine{store: st} }

// SnapshotState returns a deep-ish copy safe to serialize while traffic runs.
func (e *Engine) SnapshotState(id string, initialVars map[string]any) model.RunState {
	e.mu.Lock()
	defer e.mu.Unlock()
	st := e.store.State(id, initialVars)
	return cloneState(st)
}

// ResetScenario resets just one scenario's state.
func (e *Engine) ResetScenario(id string, initialVars map[string]any) model.RunState {
	e.mu.Lock()
	defer e.mu.Unlock()
	return *e.store.ResetState(id, initialVars)
}

func cloneState(st *model.RunState) model.RunState {
	cp := model.RunState{
		Vars:     map[string]any{},
		Counters: map[string]int{},
		Seq:      st.Seq,
		History:  append([]model.HistoryEntry{}, st.History...),
	}
	for k, v := range st.Vars {
		cp.Vars[k] = v
	}
	for k, v := range st.Counters {
		cp.Counters[k] = v
	}
	return cp
}

type matchT struct {
	ep       *model.Endpoint
	pathVars map[string]string
}

// ServeMock handles a mock call to /m/{scenarioID}/{endpoint path}.
func (e *Engine) ServeMock(sc model.Scenario, w http.ResponseWriter, r *http.Request) {
	state := e.store.State(sc.ID, sc.InitialVars)

	mt := matchPath(&sc, r.Method, r.URL.Path)
	if mt == nil {
		http.Error(w, fmt.Sprintf("no enabled endpoint for %s %s", r.Method, r.URL.Path), http.StatusNotFound)
		return
	}

	bodyBytes, _ := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	query := map[string]any{}
	for k, vs := range r.URL.Query() {
		if len(vs) > 0 {
			query[k] = vs[len(vs)-1]
		}
	}
	headers := map[string]any{}
	for k, vs := range r.Header {
		if len(vs) > 0 {
			headers[strings.ToLower(k)] = vs[len(vs)-1]
		}
	}
	pathVals := map[string]any{}
	for k, v := range mt.pathVars {
		pathVals[k] = v
	}
	var body any
	if len(bodyBytes) > 0 {
		if strings.Contains(r.Header.Get("Content-Type"), "json") {
			_ = json.Unmarshal(bodyBytes, &body)
		}
		if body == nil {
			body = map[string]any{"_raw": string(bodyBytes)}
		}
	}

	e.mu.Lock()
	state.Counters[mt.ep.ID]++
	calls := state.Counters[mt.ep.ID]
	ec := &expr.Context{
		Body:    body,
		Query:   query,
		Headers: headers,
		Path:    pathVals,
		State:   state.Vars,
		Calls:   calls,
	}

	rules := enabledRulesSorted(&sc, mt.ep.ID)
	var chosen *model.Rule
	for i := range rules {
		ok, err := conditionsHold(&rules[i], ec)
		if err == nil && ok {
			chosen = &rules[i]
			break
		}
	}
	e.mu.Unlock()

	respStatus := 200
	respBody := fmt.Sprintf("{\"message\":\"no rule matched %s %s\"}", r.Method, r.URL.Path)
	respHeaders := map[string]string{"Content-Type": "application/json; charset=utf-8"}
	delayMs := 0
	var failure *model.Failure
	matchedID := ""

	if chosen != nil {
		matchedID = chosen.ID
		delayMs = chosen.DelayMs
		failure = chosen.Failure
		if delayMs > 0 {
			select {
			case <-time.After(time.Duration(delayMs) * time.Millisecond):
			case <-r.Context().Done():
				return
			}
		}

		e.mu.Lock()
		applyErr := applyOperations(chosen, ec)
		var renderErr error
		respStatus = chosen.Response.Status
		if respStatus == 0 {
			respStatus = 200
		}
		for k, v := range chosen.Response.Headers {
			rv, err := expr.Render(v, ec)
			if err == nil {
				respHeaders[k] = rv
			}
		}
		respBody, renderErr = expr.Render(chosen.Response.Body, ec)
		e.mu.Unlock()
		if applyErr != nil {
			http.Error(w, "state operation error: "+applyErr.Error(), http.StatusInternalServerError)
			return
		}
		if renderErr != nil {
			http.Error(w, "template render error: "+renderErr.Error(), http.StatusInternalServerError)
			return
		}
	}

	start := time.Now()
	entry := model.HistoryEntry{
		Method:        r.Method,
		Path:          r.URL.Path,
		MatchedRuleID: matchedID,
		DelayMs:       delayMs,
		ReqHeaders:    flattenHeaders(r.Header),
		ReqBody:       string(bodyBytes),
		RespHeaders:   respHeaders,
	}

	if failure != nil {
		switch failure.Type {
		case "timeout":
			wait := time.Duration(failure.TimeoutMs) * time.Millisecond
			select {
			case <-time.After(wait):
			}
			entry.Failure = "timeout"
			entry.Status = 0
			if hj, ok := w.(http.Hijacker); ok {
				if conn, _, err := hj.Hijack(); err == nil {
					_ = conn.Close()
				}
			}
			e.record(sc.ID, state, entry, time.Since(start))
			return
		case "disconnect":
			entry.Failure = "disconnect"
			entry.Status = 0
			if hj, ok := w.(http.Hijacker); ok {
				if conn, _, err := hj.Hijack(); err == nil {
					_ = conn.Close()
				}
			}
			e.record(sc.ID, state, entry, time.Since(start))
			return
		case "http_error":
			respStatus = failure.Status
			msg := failure.Message
			if strings.TrimSpace(msg) == "" {
				msg = http.StatusText(respStatus)
			}
			respBody = fmt.Sprintf("{\"error\":%q,\"status\":%d}", msg, respStatus)
			entry.Failure = "http_error"
		}
	}

	for k, v := range respHeaders {
		w.Header().Set(k, v)
	}
	w.WriteHeader(respStatus)
	_, _ = io.WriteString(w, respBody)
	entry.Status = respStatus
	entry.RespBody = respBody
	e.record(sc.ID, state, entry, time.Since(start))
}

func (e *Engine) record(id string, state *model.RunState, entry model.HistoryEntry, elapsed time.Duration) {
	e.mu.Lock()
	defer e.mu.Unlock()
	state.Seq++
	entry.Seq = state.Seq
	entry.At = time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
	entry.ElapsedMs = elapsed.Milliseconds()
	state.History = append(state.History, entry)
	if len(state.History) > 200 {
		state.History = state.History[len(state.History)-200:]
	}
	e.store.PersistState(id)
}

func enabledRulesSorted(sc *model.Scenario, endpointID string) []model.Rule {
	out := []model.Rule{}
	for _, r := range sc.Rules {
		if r.Enabled && r.EndpointID == endpointID {
			out = append(out, r)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Priority < out[j].Priority })
	return out
}

func matchPath(sc *model.Scenario, method, urlPath string) *matchT {
	method = strings.ToUpper(method)
	for i := range sc.Endpoints {
		ep := &sc.Endpoints[i]
		if !ep.Enabled || strings.ToUpper(ep.Method) != method {
			continue
		}
		if vars, ok := segmentsMatch(ep.Path, urlPath); ok {
			return &matchT{ep: ep, pathVars: vars}
		}
	}
	return nil
}

func segmentsMatch(pattern, actual string) (map[string]string, bool) {
	ps := strings.Split(strings.Trim(pattern, "/"), "/")
	as := strings.Split(strings.Trim(actual, "/"), "/")
	if len(ps) != len(as) {
		return nil, false
	}
	vars := map[string]string{}
	for i, p := range ps {
		if strings.HasPrefix(p, "{") && strings.HasSuffix(p, "}") {
			vars[p[1:len(p)-1]] = as[i]
		} else if p != as[i] {
			return nil, false
		}
	}
	return vars, true
}

func conditionsHold(r *model.Rule, c *expr.Context) (bool, error) {
	for _, cd := range r.Conditions {
		left, err := expr.Eval(cd.Field, c)
		if err != nil {
			return false, err
		}
		if !conditionHolds(cd.Op, left, cd.Value) {
			return false, nil
		}
	}
	return true, nil
}

func conditionHolds(op string, left, wanted any) bool {
	switch op {
	case "exists":
		return left != nil && left != ""
	case "eq":
		return looseEqual(left, wanted)
	case "ne":
		return !looseEqual(left, wanted)
	case "gt", "gte", "lt", "lte":
		x, ok1 := asNum(left)
		y, ok2 := asNum(wanted)
		if !ok1 || !ok2 {
			return false
		}
		switch op {
		case "gt":
			return x > y
		case "gte":
			return x >= y
		case "lt":
			return x < y
		case "lte":
			return x <= y
		}
	case "contains":
		switch l := left.(type) {
		case string:
			w, _ := wanted.(string)
			return strings.Contains(l, w)
		case []any:
			for _, item := range l {
				if looseEqual(item, wanted) {
					return true
				}
			}
		}
		return false
	case "in":
		arr, ok := wanted.([]any)
		if !ok {
			return false
		}
		for _, item := range arr {
			if looseEqual(left, item) {
				return true
			}
		}
		return false
	}
	return false
}

func looseEqual(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	if x, ok1 := asNum(a); ok1 {
		if y, ok2 := asNum(b); ok2 {
			return x == y
		}
	}
	return fmt.Sprint(a) == fmt.Sprint(b)
}

func asNum(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case bool:
		if n {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

func applyOperations(r *model.Rule, c *expr.Context) error {
	for _, op := range r.Operations {
		key := strings.TrimPrefix(op.Target, "state.")
		switch op.Op {
		case "unset":
			delete(c.State, key)
		case "set":
			v, err := expr.Eval(op.Value, c)
			if err != nil {
				return fmt.Errorf("%s: %w", op.Target, err)
			}
			c.State[key] = v
		case "increment":
			v, err := expr.Eval(op.Value, c)
			if err != nil {
				return fmt.Errorf("%s: %w", op.Target, err)
			}
			dlt, ok := asNum(v)
			if !ok {
				return fmt.Errorf("%s: increment value must be numeric, got %T", op.Target, v)
			}
			cur, _ := asNum(c.State[key])
			c.State[key] = cur + dlt
		}
	}
	return nil
}

func flattenHeaders(h http.Header) map[string]string {
	out := map[string]string{}
	for k, v := range h {
		if len(v) > 0 {
			out[k] = strings.Join(v, ", ")
		}
	}
	return out
}
