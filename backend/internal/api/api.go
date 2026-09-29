// Package api wires the HTTP endpoints for the design surface and mock traffic.
package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"mockplatform/internal/engine"
	"mockplatform/internal/model"
	"mockplatform/internal/store"
	"mockplatform/internal/validate"
)

type Server struct {
	store  *store.Store
	engine *engine.Engine
}

func New(st *store.Store) *Server {
	return &Server{store: st, engine: engine.New(st)}
}

func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/scenarios", s.handleScenarios)
	mux.HandleFunc("/api/scenarios/", s.handleScenario)
	mux.HandleFunc("/m/", s.handleMock)
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok"})
	})
	return mux
}

func (s *Server) handleScenarios(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, 200, s.store.List())
	case http.MethodPost:
		var sc model.Scenario
		if err := readJSON(r, &sc); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		if sc.ID == "" {
			sc.ID = newID("sc")
		}
		ensureIDs(&sc)
		if err := s.store.Put(&sc); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		writeJSON(w, 201, sc)
	default:
		writeError(w, 405, "method not allowed")
	}
}

func (s *Server) handleScenario(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/scenarios/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, 404, "not found")
		return
	}
	id := parts[0]
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	switch action {
	case "":
		s.scenarioCRUD(id, w, r)
	case "validate":
		if r.Method != http.MethodPost {
			writeError(w, 405, "method not allowed")
			return
		}
		// Validate either the persisted scenario or the body sent by the editor.
		if r.ContentLength != 0 {
			var candidate model.Scenario
			if err := readJSON(r, &candidate); err != nil {
				writeError(w, 400, err.Error())
				return
			}
			candidate.ID = id
			issues := validate.Check(&candidate)
			writeJSON(w, 200, map[string]any{"issues": issues, "canEnable": !validate.HasErrors(issues)})
			return
		}
		sc, ok := s.store.Get(id)
		if !ok {
			writeError(w, 404, "scenario not found")
			return
		}
		issues := validate.Check(&sc)
		writeJSON(w, 200, map[string]any{"issues": issues, "canEnable": !validate.HasErrors(issues)})
	case "state":
		if r.Method != http.MethodGet {
			writeError(w, 405, "method not allowed")
			return
		}
		sc, ok := s.store.Get(id)
		if !ok {
			writeError(w, 404, "scenario not found")
			return
		}
		writeJSON(w, 200, s.engine.SnapshotState(id, sc.InitialVars))
	case "reset":
		if r.Method != http.MethodPost {
			writeError(w, 405, "method not allowed")
			return
		}
		sc, ok := s.store.Get(id)
		if !ok {
			writeError(w, 404, "scenario not found")
			return
		}
		writeJSON(w, 200, s.engine.ResetScenario(id, sc.InitialVars))
	default:
		writeError(w, 404, "not found")
	}
}

func (s *Server) scenarioCRUD(id string, w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		sc, ok := s.store.Get(id)
		if !ok {
			writeError(w, 404, "scenario not found")
			return
		}
		writeJSON(w, 200, sc)
	case http.MethodPut:
		var sc model.Scenario
		if err := readJSON(r, &sc); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		if _, ok := s.store.Get(id); !ok {
			writeError(w, 404, "scenario not found")
			return
		}
		sc.ID = id
		ensureIDs(&sc)
		if err := s.store.Put(&sc); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, sc)
	case http.MethodDelete:
		if err := s.store.Delete(id); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]string{"deleted": id})
	default:
		writeError(w, 405, "method not allowed")
	}
}

func (s *Server) handleMock(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/m/")
	parts := strings.SplitN(rel, "/", 2)
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, 404, "unknown scenario")
		return
	}
	id := parts[0]
	sc, ok := s.store.Get(id)
	if !ok {
		writeError(w, 404, "scenario not found")
		return
	}
	// Re-mount the endpoint path (without /m/{id}) so rule matching sees the designed path.
	if len(parts) == 2 {
		r.URL.Path = "/" + parts[1]
	} else {
		r.URL.Path = "/"
	}
	r.RequestURI = r.URL.Path
	s.engine.ServeMock(sc, w, r)
}

func readJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		return err
	}
	if len(raw) == 0 {
		return io.EOF
	}
	return json.Unmarshal(raw, v)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
