package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

func findEndpoint(sc *Scenario, method, path string) (*Endpoint, map[string]string, bool) {
	for i := range sc.Endpoints {
		ep := &sc.Endpoints[i]
		if !strings.EqualFold(ep.Method, method) {
			continue
		}
		if vars, ok := matchRoute(ep.Path, path); ok {
			return ep, vars, true
		}
	}
	return nil, nil, false
}

func selectRule(ep *Endpoint, body interface{}, headers, queries map[string]string, callNum int) *Rule {
	var best *Rule
	bestScore := -1 << 30
	for i := range ep.Rules {
		r := &ep.Rules[i]
		if !r.Enabled {
			continue
		}
		if r.NthCall > 0 && r.NthCall != callNum {
			continue
		}
		if !conditionMatches(r.Condition, body, headers, queries) {
			continue
		}
		score := r.Priority
		if r.Condition != nil {
			score += conditionSpecificity(r.Condition)
		}
		if r.NthCall > 0 {
			score += 100000 // exact call number beats generic rules
		}
		if score > bestScore {
			bestScore = score
			best = r
		}
	}
	return best
}

func conditionSpecificity(c *Condition) int {
	n := len(c.Headers) + len(c.Queries) + len(c.Body)
	return n
}

func (s *Server) serveMock(w http.ResponseWriter, r *http.Request, scenarioID string) {
	s.store.lock()
	sc, ok := s.store.scenarios[scenarioID]
	if !ok {
		s.store.unlock()
		http.Error(w, `{"error":"scenario not found"}`, http.StatusNotFound)
		return
	}
	if !sc.Enabled {
		s.store.unlock()
		http.Error(w, `{"error":"scenario disabled"}`, http.StatusConflict)
		return
	}
	headers := map[string]string{}
	for k := range r.Header {
		headers[k] = r.Header.Get(k)
	}
	queries := map[string]string{}
	for k := range r.URL.Query() {
		queries[k] = r.URL.Query().Get(k)
	}
	raw, _ := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	var body interface{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &body)
	}

	ep, pathVars, found := findEndpoint(sc, r.Method, r.URL.Path)
	if !found {
		s.store.unlock()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"no endpoint matched in scenario"}`))
		return
	}

	sc.Counters[ep.ID]++
	callNum := sc.Counters[ep.ID]
	rule := selectRule(ep, body, headers, queries, callNum)

	status := ep.DefaultStatus
	if status == 0 {
		status = 200
	}
	delayMS := 0
	var fail *Failure
	respHeaders := map[string]string{}
	respBody := ep.DefaultBody
	var extracts []Extract
	if rule != nil {
		status = rule.Status
		delayMS = rule.DelayMS
		fail = rule.Fail
		respHeaders = cloneStringMap(rule.Headers)
		respBody = rule.Body
		extracts = rule.Extract
	}
	for k, v := range ep.DefaultHeaders {
		if _, ok := respHeaders[k]; !ok {
			respHeaders[k] = v
		}
	}

	// Rendering and extraction must happen while we hold state, but the delay
	// should happen without blocking other scenarios' requests. Snapshot the
	// inputs, release the lock during the delay, then re-lock to apply.
	// State is committed only when the call actually completes: a simulated
	// failure or a client cancellation must not leak values into later calls.
	stateBefore := cloneState(sc.State)
	rctx := renderContext{
		state: stateBefore, body: body, headers: headers, queries: queries,
		pathVars: pathVars, callNum: callNum,
	}
	newState := cloneState(stateBefore)
	for _, ex := range extracts {
		var (
			v   interface{}
			got bool
		)
		switch ex.From {
		case "body":
			v, got = resolvePath(body, ex.Path)
		case "header":
			v, got = lookupCI(headers, ex.Path)
		case "query":
			v, got = queries[ex.Path]
		case "path":
			v, got = pathVars[ex.Path]
		}
		if got {
			if strings.Contains(ex.Key, ".") {
				setPath(newState, ex.Key, v)
			} else {
				newState[ex.Key] = v
			}
		}
	}
	rctx.state = newState
	rendered, _ := renderTemplate(respBody, rctx)
	renderedHeaders := map[string]string{}
	for k, v := range respHeaders {
		rv, _ := renderTemplate(v, rctx)
		renderedHeaders[k] = rv
	}

	record := CallRecord{
		Time:       time.Now().UTC().Format(time.RFC3339),
		EndpointID: ep.ID,
		Method:     r.Method,
		Path:       r.URL.Path,
		Status:     status,
		Failed:     fail,
		DelayMS:    delayMS,
		ReqHeaders: headers,
		ReqQuery:   queries,
		ReqBody:    body,
	}
	if rule != nil {
		record.RuleID = rule.ID
	}
	s.store.unlock()

	if delayMS > 0 {
		timer := time.NewTimer(time.Duration(delayMS) * time.Millisecond)
		select {
		case <-r.Context().Done():
			timer.Stop()
			s.store.lock()
			record.Cancelled = true
			record.Status = 0
			record.Seq = len(sc.History) + 1
			sc.History = append(sc.History, record)
			s.store.unlock()
			return
		case <-timer.C:
		}
	}
	if fail != nil {
		s.store.lock()
		record.Seq = len(sc.History) + 1
		sc.History = append(sc.History, record)
		s.store.unlock()
		simulateFailure(w, fail, delayMS)
		return
	}
	// The call completes normally: commit extracted state and history.
	s.store.lock()
	sc.State = newState
	record.StateAfter = cloneState(newState)
	record.Seq = len(sc.History) + 1
	sc.History = append(sc.History, record)
	s.store.unlock()
	for k, v := range renderedHeaders {
		w.Header().Set(k, v)
	}
	if ct := w.Header().Get("Content-Type"); ct == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	}
	w.WriteHeader(status)
	_, _ = io.WriteString(w, rendered)
}

func cloneStringMap(m map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range m {
		out[k] = v
	}
	return out
}

// simulateFailure drops the connection (reset) or holds it open until the
// client gives up (timeout), matching the rule definition.
func simulateFailure(w http.ResponseWriter, f *Failure, delayMS int) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "failure simulation unsupported", http.StatusInternalServerError)
		return
	}
	conn, bufrw, err := hj.Hijack()
	if err != nil {
		return
	}
	switch f.Kind {
	case "reset":
		if tc, ok := conn.(*net.TCPConn); ok {
			_ = tc.SetLinger(0)
		}
		_ = conn.Close()
	case "timeout":
		_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
		// Write nothing; discard anything the client sends until deadline.
		br := bufio.NewReader(bufrw)
		for {
			if _, err := br.ReadByte(); err != nil {
				return
			}
		}
	}
}
