package main

import (
	"crypto/rand"
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
	mux.HandleFunc("POST /api/scenarios/{id}/sequences", s.saveSequenceHandler)
	mux.HandleFunc("DELETE /api/scenarios/{id}/sequences/{seqId}", s.deleteSequenceHandler)
	mux.Handle("/mocks/{id}/", http.StripPrefix("/mocks/", &mockHandler{s: s}))
	return logging(mux)
}

func (s *Server) saveSequenceHandler(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var seq Sequence
	if err := json.NewDecoder(r.Body).Decode(&seq); err != nil {
		writeErr(w, 400, "invalid JSON: "+err.Error())
		return
	}
	if strings.TrimSpace(seq.Name) == "" {
		writeErr(w, 400, "序列名称不能为空")
		return
	}
	if len(seq.Steps) == 0 {
		writeErr(w, 400, "序列至少包含一个请求步骤")
		return
	}
	saved, ok, err := s.store.saveSequence(id, seq)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if !ok {
		writeErr(w, 404, "scenario not found")
		return
	}
	writeJSON(w, 200, saved)
}

func (s *Server) deleteSequenceHandler(w http.ResponseWriter, r *http.Request) {
	saved, ok := s.store.deleteSequence(r.PathValue("id"), r.PathValue("seqId"))
	if !ok {
		writeErr(w, 404, "scenario not found")
		return
	}
	writeJSON(w, 200, saved)
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
	sc.ID = newID("sc")
	sc.Enabled = false
	sc.Endpoints = normalizeEndpoints(sc.Endpoints)
	saved, err := s.store.upsert(sc)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	s.store.lock()
	cp := snapshot(saved)
	s.store.unlock()
	writeJSON(w, 201, cp)
}

func normalizeEndpoints(eps []Endpoint) []Endpoint {
	for i := range eps {
		if eps[i].ID == "" {
			eps[i].ID = newID("ep")
		}
		for j := range eps[i].Rules {
			if eps[i].Rules[j].ID == "" {
				eps[i].Rules[j].ID = newID("rule")
			}
		}
	}
	return eps
}

func (s *Server) getScenario(w http.ResponseWriter, r *http.Request) {
	sc, ok := s.store.get(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, "scenario not found")
		return
	}
	s.store.lock()
	cp := snapshot(sc)
	s.store.unlock()
	writeJSON(w, 200, cp)
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
	in.Endpoints = normalizeEndpoints(in.Endpoints)
	saved, err := s.store.upsert(in)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	s.store.lock()
	cp := snapshot(saved)
	s.store.unlock()
	writeJSON(w, 200, cp)
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
	s.store.lock()
	cp := snapshot(sc)
	s.store.unlock()
	writeJSON(w, 200, cp)
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
