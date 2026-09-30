package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// Exercises the mock handler directly (no socket): nth-call rule selects the
// failure on call 1 and the success rule on call 2, extraction chains across
// requests, and history/failure stay attributed to the individual request.
func TestMockFlow_FirstFailRuleThenSuccessWithStateChain(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{
	  "name":"flow",
	  "initialState": {},
	  "endpoints": [
	    {"name":"create","method":"POST","path":"/orders","defaultStatus":201,"defaultBody":"{}",
	     "rules":[
	       {"id":"f1","name":"first-fail","enabled":true,"nthCall":1,"status":503,"body":"{\"error\":\"busy\"}",
	        "extract":[{"from":"body","path":"id","key":"orderId"}]},
	       {"id":"ok","name":"ok","enabled":true,"status":201,"body":"{\"id\":\"{{body.id}}\"}",
	        "extract":[{"from":"body","path":"id","key":"orderId"}]}
	     ]},
	    {"name":"get","method":"GET","path":"/orders/:id","defaultStatus":200,
	     "defaultBody":"{\"lastCreated\":\"{{state.orderId}}\"}"}
	  ]}`)
	enable(t, h, sc.ID)

	callMock := func(method, target, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/mocks/"+sc.ID+target, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w
	}

	w1 := callMock("POST", "/orders", `{"id":"A1"}`)
	if w1.Code != 503 || !strings.Contains(w1.Body.String(), "busy") {
		t.Fatalf("call1 = %d %s", w1.Code, w1.Body.String())
	}
	w2 := callMock("POST", "/orders", `{"id":"A2"}`)
	if w2.Code != 201 || !strings.Contains(w2.Body.String(), "A2") {
		t.Fatalf("call2 = %d %s", w2.Code, w2.Body.String())
	}
	w3 := callMock("GET", "/orders/A2", "")
	if !strings.Contains(w3.Body.String(), "A2") {
		t.Fatalf("GET did not use extracted state: %s", w3.Body.String())
	}

	got := getScenarioJSON(t, h, sc.ID)
	if len(got.History) != 3 {
		t.Fatalf("want 3 records, got %d", len(got.History))
	}
	if got.History[0].Status != 503 || got.History[1].Status != 201 {
		t.Fatalf("history statuses wrong: %+v %+v", got.History[0], got.History[1])
	}
	if got.History[0].RuleID != "f1" || got.History[1].RuleID != "ok" {
		t.Fatalf("nth-call rule attribution wrong: %+v %+v", got.History[0], got.History[1])
	}
	if got.Counters[sc.Endpoints[0].ID] != 2 {
		t.Fatalf("counter=%+v", got.Counters)
	}
}
