package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// End-to-end check through a real loopback server: first call fails (reset)
// but still records history, second call succeeds, state carries the id, and
// the GET uses it via {{state.orderId}}.
func TestE2E_FirstFailThenSuccessAndStateChain(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Skipf("cannot listen: %v", r)
		}
	}()
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{
	  "name":"flow",
	  "initialState": {"token":"t"},
	  "endpoints": [
	    {"name":"create","method":"POST","path":"/orders","defaultStatus":201,"defaultBody":"{}",
	     "rules":[
	       {"id":"f1","name":"first-reset","enabled":true,"nthCall":1,"delayMs":5,"fail":{"kind":"reset"},"status":0,"body":"",
	        "extract":[{"from":"body","path":"id","key":"orderId"}]},
	       {"id":"ok","name":"ok","enabled":true,"status":201,"body":"{\"id\":\"{{body.id}}\"}",
	        "extract":[{"from":"body","path":"id","key":"orderId"}]}
	     ]},
	    {"name":"get","method":"GET","path":"/orders/:id","defaultStatus":200,
	     "defaultBody":"{\"lastCreated\":\"{{state.orderId}}\"}"}
	  ]}`)
	enable(t, h, sc.ID)
	srv := httptest.NewServer(h)
	defer srv.Close()

	post := func(body string) (*http.Response, error) {
		return http.Post(srv.URL+"/mocks/"+sc.ID+"/orders", "application/json", strings.NewReader(body))
	}

	// 1st call: simulated connection reset (transport error), but history recorded.
	resp, err := post(`{"id":"ORD-1"}`)
	if err == nil {
		resp.Body.Close()
		t.Fatalf("expected reset on first call")
	}

	// 2nd call: success.
	resp, err = post(`{"id":"ORD-2"}`)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 201 || !strings.Contains(string(b), "ORD-2") {
		t.Fatalf("second call = %d %s", resp.StatusCode, b)
	}

	// GET uses cross-request state.
	gresp, err := http.Get(srv.URL + "/mocks/" + sc.ID + "/orders/ORD-2")
	if err != nil {
		t.Fatal(err)
	}
	gb, _ := io.ReadAll(gresp.Body)
	gresp.Body.Close()
	if !strings.Contains(string(gb), "ORD-2") {
		t.Fatalf("state not carried into GET: %s", gb)
	}

	// History: both calls present, first marked failed.
	got := getScenarioJSON(t, h, sc.ID)
	if len(got.History) != 2 {
		t.Fatalf("want 2 history records, got %d", len(got.History))
	}
	if got.History[0].Failed == nil || got.History[0].Failed.Kind != "reset" {
		t.Fatalf("first record should be reset failure: %+v", got.History[0])
	}
	if got.History[1].Status != 201 {
		t.Fatalf("second record status: %+v", got.History[1])
	}
	if got.Counters[got.Endpoints[0].ID] != 2 {
		t.Fatalf("counter = %+v", got.Counters)
	}

	// Reset clears runtime only.
	rreq := httptest.NewRequest("POST", "/api/scenarios/"+sc.ID+"/reset", nil)
	rw := httptest.NewRecorder()
	h.ServeHTTP(rw, rreq)
	got = getScenarioJSON(t, h, sc.ID)
	if len(got.History) != 0 || len(got.Counters) != 0 || got.State["orderId"] != nil {
		t.Fatalf("reset did not clear runtime: %+v", got)
	}
}

func TestE2E_SequenceRoundTripViaAPI(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{"name":"s","endpoints":[{"name":"e","method":"GET","path":"/p","defaultStatus":200,"defaultBody":"{\"ok\":true}"}]}`)
	body := fmt.Sprintf(`{"name":"seq1","steps":[{"endpointId":%q,"method":"GET","path":"/p","vars":{},"query":"","headers":"{}","body":""}]}`, sc.Endpoints[0].ID)
	req := httptest.NewRequest("POST", "/api/scenarios/"+sc.ID+"/sequences", strings.NewReader(body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	got := getScenarioJSON(t, h, sc.ID)
	if len(got.Sequences) != 1 || got.Sequences[0].ID == "" {
		t.Fatalf("sequence missing id: %+v", got.Sequences)
	}
	seqID := got.Sequences[0].ID

	// empty name rejected
	req2 := httptest.NewRequest("POST", "/api/scenarios/"+sc.ID+"/sequences", strings.NewReader(`{"name":"","steps":[]}`))
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, req2)
	if w2.Code != 400 {
		t.Fatalf("want 400, got %d", w2.Code)
	}

	// delete
	req3 := httptest.NewRequest("DELETE", "/api/scenarios/"+sc.ID+"/sequences/"+seqID, nil)
	w3 := httptest.NewRecorder()
	h.ServeHTTP(w3, req3)
	if w3.Code != 200 {
		t.Fatalf("delete: %d %s", w3.Code, w3.Body.String())
	}
	got = getScenarioJSON(t, h, sc.ID)
	if len(got.Sequences) != 0 {
		t.Fatalf("sequence not deleted: %+v", got.Sequences)
	}
}

func TestE2E_ContradictoryRulesBlockEnable(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{"name":"c","endpoints":[{"name":"e","method":"GET","path":"/p","defaultStatus":200,"defaultBody":"{}",
	  "rules":[
	    {"id":"a","name":"a","enabled":true,"priority":1,"status":200,"body":"{}"},
	    {"id":"b","name":"b","enabled":true,"priority":1,"status":200,"body":"{}"}
	  ]}]}`)
	req := httptest.NewRequest("POST", "/api/scenarios/"+sc.ID+"/enable", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 409 {
		t.Fatalf("want 409 conflict, got %d", w.Code)
	}
}

func getScenarioJSON(t *testing.T, h http.Handler, id string) Scenario {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/scenarios/"+id, nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("get: %d %s", w.Code, w.Body.String())
	}
	var sc Scenario
	if err := json.NewDecoder(bytes.NewReader(w.Body.Bytes())).Decode(&sc); err != nil {
		t.Fatal(err)
	}
	return sc
}
