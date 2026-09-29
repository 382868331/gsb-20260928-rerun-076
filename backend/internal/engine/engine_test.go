package engine

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"mockplatform/internal/model"
	"mockplatform/internal/store"
)

func testScenario() model.Scenario {
	return model.Scenario{
		ID:          "s1",
		Name:        "orders",
		InitialVars: map[string]any{"seq": float64(0), "created": nil},
		Endpoints: []model.Endpoint{
			{ID: "ep_order", Name: "create order", Method: "POST", Path: "/orders", Enabled: true},
			{ID: "ep_get", Name: "get order", Method: "GET", Path: "/orders/{id}", Enabled: true},
		},
		Rules: []model.Rule{
			{
				ID: "rl_fail", EndpointID: "ep_order", Name: "force 500 when flagged", Enabled: true, Priority: 1,
				Conditions: []model.Condition{{Field: "body.forceFail", Op: "eq", Value: true}},
				Failure:    &model.Failure{Type: "http_error", Status: 500, Message: "boom"},
				Response:   model.ResponseDef{Status: 500, Body: "{}"},
			},
			{
				ID: "rl_create", EndpointID: "ep_order", Name: "create", Enabled: true, Priority: 10,
				DelayMs: 30,
				Operations: []model.Operation{
					{Target: "state.seq", Op: "increment", Value: "1"},
					{Target: "state.lastId", Op: "set", Value: `concat("ORD-", state.seq)`},
				},
				Response: model.ResponseDef{Status: 201, Body: `{"id":"{{state.lastId}}","name":"{{body.name}}"}`},
			},
			{
				ID: "rl_get", EndpointID: "ep_get", Name: "get", Enabled: true, Priority: 1,
				Response: model.ResponseDef{Status: 200, Body: `{"id":"{{path.id}}","calls":{{calls}}}`},
			},
		},
	}
}

func newEngine(t *testing.T) (*Engine, *store.Store) {
	t.Helper()
	st, err := store.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return New(st), st
}

func TestStatefulFlowAndRepeats(t *testing.T) {
	eng, st := newEngine(t)
	sc := testScenario()

	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/orders", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		eng.ServeMock(sc, rr, req)
		return rr
	}

	rr1 := post(`{"name":"first"}`)
	if rr1.Code != 201 || !strings.Contains(rr1.Body.String(), "ORD-1") {
		t.Fatalf("first create: %d %s", rr1.Code, rr1.Body.String())
	}
	if rr1.Body.String() == rr1.Body.String() && rr1.Result().Header.Get("Content-Type") == "" {
		t.Fatal("content type missing")
	}
	rr2 := post(`{"name":"second"}`)
	if !strings.Contains(rr2.Body.String(), "ORD-2") {
		t.Fatalf("second create should advance state, got %s", rr2.Body.String())
	}

	// Failure branch only triggers for the matching request.
	rr3 := post(`{"name":"x","forceFail":true}`)
	if rr3.Code != 500 || !strings.Contains(rr3.Body.String(), "boom") {
		t.Fatalf("failure branch: %d %s", rr3.Code, rr3.Body.String())
	}

	// Path vars and per-endpoint repeat counters.
	for i := 1; i <= 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "/orders/ORD-2", nil)
		rr := httptest.NewRecorder()
		eng.ServeMock(sc, rr, req)
		if !strings.Contains(rr.Body.String(), `"calls":`+strconv.Itoa(i)) {
			t.Fatalf("repeat %d: %s", i, rr.Body.String())
		}
	}

	state := st.State("s1", sc.InitialVars)
	if state.Vars["lastId"] != "ORD-2" {
		t.Fatalf("state not carried: %#v", state.Vars)
	}
	if state.Counters["ep_get"] != 2 {
		t.Fatalf("counter: %d", state.Counters["ep_get"])
	}
	if len(state.History) != 5 {
		t.Fatalf("history len %d", len(state.History))
	}
}

func TestResetOnlyAffectsScenario(t *testing.T) {
	eng, st := newEngine(t)
	sc := testScenario()
	sc2 := sc
	sc2.ID = "s2"

	send := func(s model.Scenario) {
		req := httptest.NewRequest(http.MethodPost, "/orders", bytes.NewBufferString(`{"name":"a"}`))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		eng.ServeMock(s, rr, req)
	}
	send(sc)
	send(sc2)
	st.ResetState("s1", sc.InitialVars)

	s1 := st.State("s1", sc.InitialVars)
	s2 := st.State("s2", sc2.InitialVars)
	if s1.Vars["lastId"] != nil || s1.Counters["ep_order"] != 0 {
		t.Fatalf("s1 should be reset: %#v", s1)
	}
	if s2.Vars["lastId"] != "ORD-1" {
		t.Fatalf("s2 must stay isolated: %#v", s2.Vars)
	}
}

func TestDelayObserved(t *testing.T) {
	eng, _ := newEngine(t)
	sc := testScenario()
	req := httptest.NewRequest(http.MethodPost, "/orders", bytes.NewBufferString(`{"name":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	start := time.Now()
	eng.ServeMock(sc, rr, req)
	if time.Since(start) < 25*time.Millisecond {
		t.Fatal("expected 30ms delay")
	}
}
