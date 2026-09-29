// Package store persists scenario definitions and per-scenario runtime state.
package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"mockplatform/internal/model"
)

type Store struct {
	mu        sync.Mutex
	dir       string
	scenarios map[string]*model.Scenario
	states    map[string]*model.RunState
}

func New(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "scenarios"), 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(dir, "state"), 0o755); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, scenarios: map[string]*model.Scenario{}, states: map[string]*model.RunState{}}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) load() error {
	entries, err := os.ReadDir(filepath.Join(s.dir, "scenarios"))
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(s.dir, "scenarios", e.Name()))
		if err != nil {
			return err
		}
		var sc model.Scenario
		if err := json.Unmarshal(raw, &sc); err != nil {
			return fmt.Errorf("%s: %w", e.Name(), err)
		}
		s.scenarios[sc.ID] = &sc
	}
	return nil
}

func (s *Store) List() []model.Scenario {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]model.Scenario, 0, len(s.scenarios))
	for _, sc := range s.scenarios {
		out = append(out, *sc)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out
}

func (s *Store) Get(id string) (model.Scenario, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sc, ok := s.scenarios[id]
	if !ok {
		return model.Scenario{}, false
	}
	return *sc, true
}

// Put saves a scenario definition. Timestamps are maintained server-side.
func (s *Store) Put(sc *model.Scenario) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC().Format(time.RFC3339)
	if _, existed := s.scenarios[sc.ID]; !existed {
		sc.CreatedAt = now
	}
	sc.UpdatedAt = now
	if sc.InitialVars == nil {
		sc.InitialVars = map[string]any{}
	}
	raw, err := json.MarshalIndent(sc, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(s.dir, "scenarios", sc.ID+".json.tmp")
	final := filepath.Join(s.dir, "scenarios", sc.ID+".json")
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, final); err != nil {
		return err
	}
	copy := *sc
	s.scenarios[sc.ID] = &copy
	return nil
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(filepath.Join(s.dir, "scenarios", id+".json")); err != nil && !os.IsNotExist(err) {
		return err
	}
	_ = os.Remove(filepath.Join(s.dir, "state", id+".json"))
	delete(s.scenarios, id)
	delete(s.states, id)
	return nil
}

// State returns the live runtime state for a scenario, loading lazily from disk.
func (s *Store) State(id string, initialVars map[string]any) *model.RunState {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st, ok := s.states[id]; ok {
		return st
	}
	st := &model.RunState{Vars: map[string]any{}, Counters: map[string]int{}}
	if raw, err := os.ReadFile(filepath.Join(s.dir, "state", id+".json")); err == nil {
		_ = json.Unmarshal(raw, st)
		if st.Vars == nil {
			st.Vars = map[string]any{}
		}
		if st.Counters == nil {
			st.Counters = map[string]int{}
		}
	} else {
		mergeInitialVars(st.Vars, initialVars)
	}
	s.states[id] = st
	return st
}

func (s *Store) ResetState(id string, initialVars map[string]any) *model.RunState {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := &model.RunState{
		Vars:     map[string]any{},
		Counters: map[string]int{},
		History:  []model.HistoryEntry{},
	}
	mergeInitialVars(st.Vars, initialVars)
	s.states[id] = st
	s.persistStateLocked(id, st)
	return st
}

// mergeInitialVars seeds keys that were added to the scenario definition later;
// existing runtime values and keys removed from the definition are left untouched
// until the user resets the scenario.
func mergeInitialVars(vars map[string]any, initial map[string]any) {
	for k, v := range initial {
		if _, ok := vars[k]; !ok {
			vars[k] = v
		}
	}
}

func (s *Store) PersistState(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.persistStateLocked(id, s.states[id])
}

func (s *Store) persistStateLocked(id string, st *model.RunState) {
	if st == nil {
		return
	}
	// Cap stored history to keep the file small; full history is in-memory.
	persisted := *st
	if len(persisted.History) > 100 {
		persisted.History = persisted.History[len(persisted.History)-100:]
	}
	raw, _ := json.MarshalIndent(persisted, "", "  ")
	tmp := filepath.Join(s.dir, "state", id+".json.tmp")
	final := filepath.Join(s.dir, "state", id+".json")
	if err := os.WriteFile(tmp, raw, 0o644); err == nil {
		_ = os.Rename(tmp, final)
	}
}
