package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

type Server struct {
	store *Store
}

func newID(prefix string) string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return prefix + "-" + hex.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

type definitionContent struct {
	ClientID     string                 `json:"clientId,omitempty"`
	Name         string                 `json:"name"`
	Description  string                 `json:"description"`
	Enabled      bool                   `json:"enabled"`
	Endpoints    []Endpoint             `json:"endpoints"`
	InitialState map[string]interface{} `json:"initialState"`
}

func contentHash(sc *Scenario) string {
	c := definitionContent{
		ClientID: sc.ClientID, Name: sc.Name, Description: sc.Description,
		Enabled: sc.Enabled, Endpoints: sc.Endpoints, InitialState: sc.InitialState,
	}
	b, _ := json.Marshal(c)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:12])
}

func decorate(sc *Scenario) Scenario {
	cp := snapshot(sc)
	cp.ContentHash = contentHash(&cp)
	return cp
}

func decorateAll(scenarios []Scenario) []Scenario {
	for i := range scenarios {
		scenarios[i] = decorate(&scenarios[i])
	}
	return scenarios
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/scenarios", s.listScenarios)
	mux.HandleFunc("POST /api/scenarios", s.createScenario)
	mux.HandleFunc("GET /api/scenarios/{id}", s.getScenario)
	mux.HandleFunc("PUT /api/scenarios/{id}", s.updateScenario)
	mux.HandleFunc("DELETE /api/scenarios/{id}", s.deleteScenario)
	mux.HandleFunc("POST /api/scenarios/{id}/reset", s.resetScenario)
	mux.HandleFunc("POST /api/scenarios/{id}/validate", s.validateHandler)
	mux.HandleFunc("POST /api/scenarios/{id}/enable", s.enableScenario)
	mux.HandleFunc("POST /api/scenarios/{id}/rounds/{roundId}/begin", s.beginRound)
	mux.Handle("/mocks/{id}/", http.StripPrefix("/mocks/", &mockHandler{s: s}))
	return logging(mux)
}

type mockHandler struct{ s *Server }

func (h *mockHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "")
	parts := strings.SplitN(rest, "/", 2)
	id := parts[0]
	if id == "" {
		http.NotFound(w, r)
		return
	}
	// restore the full mock path for route matching
	r2 := r.Clone(r.Context())
	if len(parts) == 2 {
		r2.URL.Path = "/" + parts[1]
	} else {
		r2.URL.Path = "/"
	}
	h.s.serveMock(w, r2, id)
}

func logging(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		h.ServeHTTP(w, r)
	})
}

func (s *Server) listScenarios(w http.ResponseWriter, r *http.Request) {
	s.store.lock()
	defer s.store.unlock()
	out := make([]Scenario, 0, len(s.store.scenarios))
	for _, sc := range s.store.scenarios {
		cp := snapshot(sc)
		// lists stay light: omit history
		cp.History = nil
		cp.State = nil
		cp.Operations = nil
		cp.ContentHash = contentHash(&cp)
		out = append(out, cp)
	}
	writeJSON(w, 200, out)
}

func (s *Server) createScenario(w http.ResponseWriter, r *http.Request) {
	var sc Scenario
	if err := json.NewDecoder(r.Body).Decode(&sc); err != nil {
		writeErr(w, 400, "invalid JSON: "+err.Error())
		return
	}
	if strings.TrimSpace(sc.Name) == "" {
		writeErr(w, 400, "场景名称不能为空")
		return
	}
	if sc.ClientID != "" {
		s.store.lock()
		for _, old := range s.store.scenarios {
			if old.ClientID == sc.ClientID {
				s.store.unlock()
				writeJSON(w, 200, decorate(old))
				return
			}
		}
		s.store.unlock()
	}
	sc.ID = newID("sc")
	sc.Enabled = false
	normalizeScenario(&sc)
	saved, err := s.store.upsert(sc)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 201, decorate(saved))
}

func normalizeEndpoints(eps []Endpoint) []Endpoint {
	if eps == nil {
		eps = []Endpoint{}
	}
	for i := range eps {
		if eps[i].ID == "" {
			eps[i].ID = newID("ep")
		}
		if eps[i].Rules == nil {
			eps[i].Rules = []Rule{}
		}
		for j := range eps[i].Rules {
			if eps[i].Rules[j].ID == "" {
				eps[i].Rules[j].ID = newID("rule")
			}
			r := &eps[i].Rules[j]
			if r.Extract == nil {
				r.Extract = []Extract{}
			}
			if r.Headers == nil {
				r.Headers = map[string]string{}
			}
			if r.Condition != nil {
				if r.Condition.Headers == nil {
					r.Condition.Headers = map[string]string{}
				}
				if r.Condition.Queries == nil {
					r.Condition.Queries = map[string]string{}
				}
				if r.Condition.Body == nil {
					r.Condition.Body = []BodyMatcher{}
				}
			}
		}
		if eps[i].DefaultHeaders == nil {
			eps[i].DefaultHeaders = map[string]string{}
		}
	}
	return eps
}

// normalizeScenario guarantees the collections the frontend iterates are
// never null in JSON responses.
func normalizeScenario(sc *Scenario) {
	sc.Endpoints = normalizeEndpoints(sc.Endpoints)
	if sc.InitialState == nil {
		sc.InitialState = map[string]interface{}{}
	}
}

func (s *Server) getScenario(w http.ResponseWriter, r *http.Request) {
	sc, ok := s.store.get(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, "scenario not found")
		return
	}
	writeJSON(w, 200, decorate(sc))
}

func (s *Server) updateScenario(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := s.store.get(id); !ok {
		writeErr(w, 404, "scenario not found")
		return
	}
	var in Scenario
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, 400, "invalid JSON: "+err.Error())
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeErr(w, 400, "场景名称不能为空")
		return
	}
	in.ID = id
	normalizeScenario(&in)
	existing, ok := s.store.get(id)
	if !ok {
		writeErr(w, 404, "scenario not found")
		return
	}
	if in.ClientID != "" && existing.ClientID != "" && in.ClientID != existing.ClientID {
		writeErr(w, 409, "这是另一个本地草稿对应的场景，已保留你的输入和原场景选择")
		return
	}
	if in.ClientID == "" {
		in.ClientID = existing.ClientID
	}
	expected := r.Header.Get("X-Content-Hash")
	if expected != "" && contentHash(existing) != expected {
		writeJSON(w, 409, map[string]string{
			"error":             "场景定义在保存前已变化，已保留你的输入和原场景选择",
			"serverContentHash": contentHash(existing),
		})
		return
	}
	saved, err := s.store.upsert(in)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, decorate(saved))
}

func (s *Server) deleteScenario(w http.ResponseWriter, r *http.Request) {
	if !s.store.delete(r.PathValue("id")) {
		writeErr(w, 404, "scenario not found")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) resetScenario(w http.ResponseWriter, r *http.Request) {
	sc, ok := s.store.resetScenario(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, "scenario not found")
		return
	}
	writeJSON(w, 200, decorate(sc))
}

func (s *Server) beginRound(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	roundID := strings.TrimSpace(r.PathValue("roundId"))
	if roundID == "" {
		writeErr(w, 400, "roundId required")
		return
	}
	sc, ok := s.store.beginRound(id, roundID)
	if !ok {
		writeErr(w, 404, "scenario not found")
		return
	}
	writeJSON(w, 200, decorate(sc))
}

func (s *Server) validateHandler(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var candidate Scenario
	if err := json.NewDecoder(r.Body).Decode(&candidate); err != nil {
		writeErr(w, 400, "invalid JSON: "+err.Error())
		return
	}
	if candidate.ID == "" {
		candidate.ID = id
	}
	issues := validateScenario(&candidate)
	hasError := false
	for _, is := range issues {
		if is.Level == "error" {
			hasError = true
		}
	}
	writeJSON(w, 200, map[string]interface{}{"issues": issues, "valid": !hasError})
}

func (s *Server) enableScenario(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sc, ok := s.store.get(id)
	if !ok {
		writeErr(w, 404, "scenario not found")
		return
	}
	s.store.lock()
	cp := snapshot(sc)
	s.store.unlock()
	issues := validateScenario(&cp)
	for _, is := range issues {
		if is.Level == "error" {
			writeJSON(w, 409, map[string]interface{}{"error": "存在阻断性错误，无法启用", "issues": issues})
			return
		}
	}
	sc.Enabled = true
	if err := s.store.persist(sc); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]interface{}{"ok": true, "issues": issues})
}
