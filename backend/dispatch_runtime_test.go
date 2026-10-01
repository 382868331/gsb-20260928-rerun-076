package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func fetchScenario(t *testing.T, h http.Handler, id string) Scenario {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/scenarios/"+id, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var sc Scenario
	if err := json.Unmarshal(rec.Body.Bytes(), &sc); err != nil {
		t.Fatal(err)
	}
	return sc
}

// A rule that simulates transport failure must not commit its extracts:
// later requests must not reuse values from a call that never responded.
func TestFailureDoesNotCommitState(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{"name":"f","initialState":{"token":"orig"},
	  "endpoints":[{"name":"e","method":"POST","path":"/z","defaultStatus":200,"defaultBody":"{}",
	    "rules":[{"id":"r","name":"boom","enabled":true,"status":200,"fail":{"kind":"reset"},"body":"",
	      "extract":[{"from":"body","path":"v","key":"token"}]}]}]}`)
	enable(t, h, sc.ID)

	req := httptest.NewRequest("POST", "/mocks/"+sc.ID+"/z", strings.NewReader(`{"v":"leaked"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req) // recorder cannot hijack: simulateFailure falls back to 500

	got := fetchScenario(t, h, sc.ID)
	if got.State["token"] != "orig" {
		t.Fatalf("failed call committed state: %v", got.State)
	}
	if len(got.History) != 1 || got.History[0].Failed == nil {
		t.Fatalf("failure not recorded: %+v", got.History)
	}
	if got.History[0].StateAfter != nil {
		t.Fatalf("failed call must not have stateAfter: %+v", got.History[0])
	}
}

// A client that cancels mid-delay must not leave its extracted values behind.
func TestCancelledRequestDoesNotCommitState(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{"name":"c","initialState":{"token":"orig"},
	  "endpoints":[{"name":"e","method":"POST","path":"/slow","defaultStatus":200,"defaultBody":"{}",
	    "rules":[{"id":"r","name":"slow","enabled":true,"delayMs":300,"status":200,"body":"{}",
	      "extract":[{"from":"body","path":"v","key":"token"}]}]}]}`)
	enable(t, h, sc.ID)

	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest("POST", "/mocks/"+sc.ID+"/slow", strings.NewReader(`{"v":"leaked"}`)).WithContext(ctx)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		h.ServeHTTP(rec, req)
		close(done)
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not return after cancellation")
	}

	got := fetchScenario(t, h, sc.ID)
	if got.State["token"] != "orig" {
		t.Fatalf("cancelled call committed state: %v", got.State)
	}
	if len(got.History) != 1 || !got.History[0].Cancelled {
		t.Fatalf("cancellation not recorded: %+v", got.History)
	}
}

// Collections the frontend iterates must serialize as [], never null.
func TestEmptyCollectionsNormalized(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{"name":"bare","endpoints":[{"name":"e","method":"GET","path":"/x","defaultStatus":200,"defaultBody":"{}"}]}`)

	body := func(target string) string {
		req := httptest.NewRequest("GET", target, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Body.String()
	}
	got := body("/api/scenarios/" + sc.ID)
	if strings.Contains(got, `"rules":null`) || strings.Contains(got, `"initialState":null`) {
		t.Fatalf("null collection in detail response: %s", got)
	}
	list := body("/api/scenarios")
	if strings.Contains(list, `"rules":null`) || strings.Contains(list, `"endpoints":null`) {
		t.Fatalf("null collection in list response: %s", list)
	}

	empty := createScenario(t, h, `{"name":"no endpoints"}`)
	detail := body("/api/scenarios/" + empty.ID)
	if !strings.Contains(detail, `"endpoints":[]`) {
		t.Fatalf("endpoints should be [] : %s", detail)
	}
}
