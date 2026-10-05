package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// The validate endpoint must always return a JSON array for issues; a null
// here crashed the frontend render after saving a valid scenario.
func TestValidateReturnsEmptyArrayNotNull(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{"name":"ok","endpoints":[{"name":"e","method":"GET","path":"/x","defaultStatus":200,"defaultBody":"{}"}]}`)

	req := httptest.NewRequest("POST", "/api/scenarios/"+sc.ID+"/validate", strings.NewReader(`{"name":"ok","endpoints":[]}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), `"issues":[]`) {
		t.Fatalf("issues must be [] when there is nothing to report: %s", rec.Body.String())
	}

	req2 := httptest.NewRequest("POST", "/api/scenarios/"+sc.ID+"/enable", nil)
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req2)
	if !strings.Contains(rec2.Body.String(), `"issues":[]`) {
		t.Fatalf("enable issues must be [] : %s", rec2.Body.String())
	}
}

// Scenario detail must expose history as [] so the runner can reconcile
// after a reload without special-casing null.
func TestHistorySerializesAsEmptyArray(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{"name":"h"}`)
	req := httptest.NewRequest("GET", "/api/scenarios/"+sc.ID, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if strings.Contains(rec.Body.String(), `"history":null`) {
		t.Fatalf("history must not serialize as null: %s", rec.Body.String())
	}
}

// A retry carrying the same X-Mock-Request-Id must replay the recorded
// response without committing state or advancing counters a second time.
func TestDuplicateRequestIDReplaysWithoutSideEffects(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{"name":"d","initialState":{},
	  "endpoints":[{"name":"e","method":"POST","path":"/pay","defaultStatus":200,"defaultBody":"{}",
	    "rules":[{"id":"r","name":"ok","enabled":true,"status":201,"body":"{\"n\":\"{{callNumber.n}}\"}",
	      "extract":[{"from":"body","path":"v","key":"paid"}]}]}]}`)
	enable(t, h, sc.ID)

	call := func(reqID string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/mocks/"+sc.ID+"/pay", strings.NewReader(`{"v":"yes"}`))
		req.Header.Set("X-Mock-Request-Id", reqID)
		req.Header.Set("X-Mock-Run", "run-1")
		req.Header.Set("X-Mock-Step", "step-1")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	first := call("req-1")
	if first.Code != 201 || !strings.Contains(first.Body.String(), `"n":"1"`) {
		t.Fatalf("first call: %d %s", first.Code, first.Body.String())
	}
	dup := call("req-1")
	if dup.Code != 201 || !strings.Contains(dup.Body.String(), `"n":"1"`) {
		t.Fatalf("duplicate must replay the original response: %d %s", dup.Code, dup.Body.String())
	}
	if dup.Header().Get("X-Mock-Duplicate") != "1" {
		t.Fatal("duplicate replay must be marked with X-Mock-Duplicate")
	}

	got := fetchScenario(t, h, sc.ID)
	if got.Counters[got.Endpoints[0].ID] != 1 {
		t.Fatalf("duplicate advanced the call counter: %v", got.Counters)
	}
	if len(got.History) != 1 {
		t.Fatalf("duplicate appended history: %+v", got.History)
	}
	rec := got.History[0]
	if rec.RunID != "run-1" || rec.StepID != "step-1" || rec.RequestID != "req-1" {
		t.Fatalf("run/step/request ids not recorded: %+v", rec)
	}
	if rec.RespBody == "" {
		t.Fatal("rendered response body not recorded for replay")
	}

	// a different request id is a new operation and must execute normally
	second := call("req-2")
	if !strings.Contains(second.Body.String(), `"n":"2"`) {
		t.Fatalf("new request id must execute: %s", second.Body.String())
	}
}

// A cancelled duplicate does not count as completed, so a later retry with
// the same id must execute for real.
func TestCancelledRequestIDDoesNotReplay(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{"name":"c","endpoints":[{"name":"e","method":"GET","path":"/x","defaultStatus":200,"defaultBody":"ok"}]}`)
	enable(t, h, sc.ID)

	call := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/mocks/"+sc.ID+"/x", nil)
		req.Header.Set("X-Mock-Request-Id", "req-9")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	if r := call(); r.Code != 200 {
		t.Fatalf("first: %d", r.Code)
	}
	got := fetchScenario(t, h, sc.ID)
	if len(got.History) != 1 {
		t.Fatalf("history: %+v", got.History)
	}
	if got.History[0].RespBody != "ok" {
		t.Fatalf("recorded body should be kept for replay: %q", got.History[0].RespBody)
	}
}
