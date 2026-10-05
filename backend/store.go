package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

type Store struct {
	mu        sync.Mutex
	dir       string
	scenarios map[string]*Scenario
}

func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, scenarios: map[string]*Scenario{}}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var sc Scenario
		if err := json.Unmarshal(b, &sc); err != nil {
			continue
		}
		normalizeScenario(&sc)
		sc.resetRuntime()
		s.loadRuntime(&sc)
		s.scenarios[sc.ID] = &sc
	}
	return s, nil
}

func (s *Store) list() []Scenario {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Scenario, 0, len(s.scenarios))
	for _, sc := range s.scenarios {
		out = append(out, *sc)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out
}

func (s *Store) get(id string) (*Scenario, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sc, ok := s.scenarios[id]
	return sc, ok
}

func (s *Store) lock()   { s.mu.Lock() }
func (s *Store) unlock() { s.mu.Unlock() }

func cloneState(m map[string]interface{}) map[string]interface{} {
	if m == nil {
		return map[string]interface{}{}
	}
	b, _ := json.Marshal(m)
	var c map[string]interface{}
	_ = json.Unmarshal(b, &c)
	if c == nil {
		c = map[string]interface{}{}
	}
	return c
}

func (sc *Scenario) resetRuntime() {
	sc.State = cloneState(sc.InitialState)
	sc.Counters = map[string]int{}
	sc.History = nil
	sc.Operations = []OperationRecord{}
	sc.ActiveRoundID = ""
}

func (s *Store) save(sc *Scenario, persist bool) error {
	s.scenarios[sc.ID] = sc
	if !persist {
		return nil
	}
	b, err := json.MarshalIndent(sc, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(s.dir, sc.ID+".json.tmp")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(s.dir, sc.ID+".json"))
}

// upsert replaces the definition but keeps runtime state and counters.
func (s *Store) upsert(in Scenario) (*Scenario, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	normalizeScenario(&in)
	now := time.Now().UTC().Format(time.RFC3339)
	existing, ok := s.scenarios[in.ID]
	if ok {
		rt := *existing
		rt.Name = in.Name
		rt.Description = in.Description
		rt.Enabled = in.Enabled
		rt.Endpoints = in.Endpoints
		rt.InitialState = cloneState(in.InitialState)
		rt.UpdatedAt = now
		rt.State = cloneState(rt.InitialState)
		rt.Counters = map[string]int{}
		rt.History = nil
		rt.Operations = []OperationRecord{}
		rt.ActiveRoundID = ""
		_ = s.persistRuntime(&rt)
		if err := s.persist(&rt); err != nil {
			return nil, err
		}
		return &rt, nil
	}
	in.CreatedAt, in.UpdatedAt = now, now
	in.resetRuntime()
	_ = s.persistRuntime(&in)
	if err := s.persist(&in); err != nil {
		return nil, err
	}
	return &in, nil
}

func (s *Store) persist(sc *Scenario) error {
	s.scenarios[sc.ID] = sc
	clean := *sc
	clean.State = nil
	clean.Counters = nil
	clean.History = nil
	clean.Operations = nil
	clean.ActiveRoundID = ""
	clean.ContentHash = ""
	b, err := json.MarshalIndent(&clean, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(s.dir, sc.ID+".json.tmp")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(s.dir, sc.ID+".json"))
}

func (s *Store) runtimePath(id string) string {
	return filepath.Join(s.dir, id+".runtime.json")
}

type persistedRuntime struct {
	State         map[string]interface{} `json:"state"`
	Counters      map[string]int         `json:"counters"`
	History       []CallRecord           `json:"history"`
	ActiveRoundID string                 `json:"activeRoundId"`
	Operations    []OperationRecord      `json:"operations"`
}

// loadRuntime restores only request facts. A pending operation stays pending
// after a process restart: that correctly means "result unknown" until the
// user checks or explicitly starts an independent replacement round.
func (s *Store) loadRuntime(sc *Scenario) {
	b, err := os.ReadFile(s.runtimePath(sc.ID))
	if err != nil {
		return
	}
	var rt persistedRuntime
	if err := json.Unmarshal(b, &rt); err != nil {
		return
	}
	sc.State = cloneState(rt.State)
	if len(sc.State) == 0 {
		if len(rt.State) == 0 && sc.InitialState != nil && len(sc.InitialState) > 0 {
			sc.State = cloneState(sc.InitialState)
		}
	}
	sc.Counters = map[string]int{}
	for k, v := range rt.Counters {
		sc.Counters[k] = v
	}
	sc.History = rt.History
	sc.ActiveRoundID = rt.ActiveRoundID
	sc.Operations = rt.Operations
	if sc.Operations == nil {
		sc.Operations = []OperationRecord{}
	}
}

func (s *Store) persistRuntime(sc *Scenario) error {
	rt := persistedRuntime{
		State:         cloneState(sc.State),
		Counters:      map[string]int{},
		History:       sc.History,
		ActiveRoundID: sc.ActiveRoundID,
		Operations:    sc.Operations,
	}
	for k, v := range sc.Counters {
		rt.Counters[k] = v
	}
	b, err := json.MarshalIndent(rt, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(s.dir, sc.ID+".runtime.json.tmp")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.runtimePath(sc.ID))
}

func (s *Store) beginRound(id, roundID string) (*Scenario, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sc, ok := s.scenarios[id]
	if !ok {
		return nil, false
	}
	sc.State = cloneState(sc.InitialState)
	sc.Counters = map[string]int{}
	sc.History = []CallRecord{}
	sc.ActiveRoundID = roundID
	sc.Operations = []OperationRecord{}
	_ = s.persistRuntime(sc)
	return sc, true
}

func (s *Store) putOperation(sc *Scenario, op OperationRecord) error {
	replaced := false
	for i := range sc.Operations {
		if sc.Operations[i].RequestID == op.RequestID {
			sc.Operations[i] = op
			replaced = true
			break
		}
	}
	if !replaced {
		sc.Operations = append(sc.Operations, op)
	}
	return s.persistRuntime(sc)
}

func (s *Store) findOperation(sc *Scenario, requestID string) (OperationRecord, bool) {
	for _, op := range sc.Operations {
		if op.RequestID == requestID {
			return op, true
		}
	}
	return OperationRecord{}, false
}

func (s *Store) delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.scenarios[id]; !ok {
		return false
	}
	delete(s.scenarios, id)
	_ = os.Remove(filepath.Join(s.dir, id+".json"))
	_ = os.Remove(s.runtimePath(id))
	return true
}

func (s *Store) resetScenario(id string) (*Scenario, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sc, ok := s.scenarios[id]
	if !ok {
		return nil, false
	}
	sc.resetRuntime()
	_ = s.persistRuntime(sc)
	return sc, true
}

// snapshot deep-copies a scenario for API responses; caller must hold s.mu.
func snapshot(sc *Scenario) Scenario {
	cp := *sc
	cp.State = cloneState(sc.State)
	cp.InitialState = cloneState(sc.InitialState)
	cp.Counters = map[string]int{}
	for k, v := range sc.Counters {
		cp.Counters[k] = v
	}
	if len(sc.History) > 0 {
		cp.History = append([]CallRecord(nil), sc.History...)
	}
	if len(sc.Operations) > 0 {
		cp.Operations = append([]OperationRecord(nil), sc.Operations...)
	}
	return cp
}
