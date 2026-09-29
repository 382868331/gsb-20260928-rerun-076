package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"mockplatform/internal/model"
)

func setupServer(t *testing.T) http.Handler {
	t.Helper()
	// store.New needs a dir; use TEST_TMPDIR-like tempdir via testing.
	st, err := newTestStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return New(st).Routes()
}

func TestFullLifecycleOverHTTP(t *testing.T) {
	h := setupServer(t)

	// Create scenario with a stateful rule.
	sc := model.Scenario{
		Name:        "shop",
		InitialVars: map[string]any{"n": float64(0)},
		Endpoints:   []model.Endpoint{{ID: "ep1", Name: "create", Method: "POST", Path: "/orders", Enabled: true}},
		Rules: []model.Rule{{
			ID:         "r1",
			EndpointID: "ep1",
			Name:       "create",
			Enabled:    true,
			Priority:   1,
			Operations: []model.Operation{{Target: "state.n", Op: "increment", Value: "1"}},
			Response:   model.ResponseDef{Status: 201, Body: `{"n":{{state.n}},"name":"{{body.name}}"}`},
		}},
	}
	raw, _ := json.Marshal(sc)
	req := httptest.NewRequest(http.MethodPost, "/api/scenarios", bytes.NewReader(raw))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 201 {
		t.Fatalf("create: %d %s", rr.Code, rr.Body.String())
	}
	var saved model.Scenario
	_ = json.Unmarshal(rr.Body.Bytes(), &saved)
	if !strings.HasPrefix(saved.ID, "sc_") {
		t.Fatalf("unexpected id %q", saved.ID)
	}

	// Validate reports clean.
	req = httptest.NewRequest(http.MethodPost, "/api/scenarios/"+saved.ID+"/validate", bytes.NewReader(raw))
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if !strings.Contains(rr.Body.String(), "\"canEnable\":true") {
		t.Fatalf("validate: %s", rr.Body.String())
	}

	// Two real mock calls carry state across requests.
	call := func(name string) string {
		req := httptest.NewRequest(http.MethodPost, "/m/"+saved.ID+"/orders", bytes.NewBufferString(`{"name":"`+name+`"}`))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != 201 {
			t.Fatalf("mock: %d %s", rr.Code, rr.Body.String())
		}
		return rr.Body.String()
	}
	if got := call("a"); !strings.Contains(got, `"n":1`) || !strings.Contains(got, `"name":"a"`) {
		t.Fatalf("call1 %s", got)
	}
	if got := call("b"); !strings.Contains(got, `"n":2`) {
		t.Fatalf("call2 %s", got)
	}

	// Persistence: a fresh server (same dir) sees definition and state.
	h2h := reopenHandler(t, h)
	req = httptest.NewRequest(http.MethodGet, "/api/scenarios/"+saved.ID+"/state", nil)
	rr = httptest.NewRecorder()
	h2h.ServeHTTP(rr, req)
	if !strings.Contains(rr.Body.String(), `"n":2`) {
		t.Fatalf("state not persisted: %s", rr.Body.String())
	}

	// Reset clears only this scenario.
	req = httptest.NewRequest(http.MethodPost, "/api/scenarios/"+saved.ID+"/reset", nil)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if !strings.Contains(rr.Body.String(), `"n":0`) {
		t.Fatalf("reset: %s", rr.Body.String())
	}
}

func TestConflictRejectedOnValidate(t *testing.T) {
	h := setupServer(t)
	sc := model.Scenario{
		Name:      "bad",
		Endpoints: []model.Endpoint{{ID: "ep1", Name: "a", Method: "GET", Path: "/a", Enabled: true}},
		Rules: []model.Rule{
			{ID: "r1", EndpointID: "ep1", Enabled: true, Priority: 1, Response: model.ResponseDef{Status: 200, Body: "{}"}},
			{ID: "r2", EndpointID: "ep1", Enabled: true, Priority: 2, Response: model.ResponseDef{Status: 200, Body: "{}"}},
		},
	}
	raw, _ := json.Marshal(sc)
	req := httptest.NewRequest(http.MethodPost, "/api/scenarios/x/validate", bytes.NewReader(raw))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if !strings.Contains(rr.Body.String(), "\"canEnable\":false") ||
		!strings.Contains(rr.Body.String(), "RULE_SHADOWS") {
		t.Fatalf("expected blocking issues: %s", rr.Body.String())
	}
}
