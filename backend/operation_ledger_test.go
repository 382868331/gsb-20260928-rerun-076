package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTrackedOperationRecordsFactsAndIsIdempotent(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{"name":"ops","initialState":{"v":"old"},"endpoints":[{"name":"e","method":"POST","path":"/op","defaultStatus":200,"defaultBody":"{}","rules":[{"id":"r","name":"r","enabled":true,"status":201,"body":"{\"ok\":true}","extract":[{"from":"body","path":"id","key":"v"}]}]}]}`)
	enable(t, h, sc.ID)
	req := httptest.NewRequest("POST", "/api/scenarios/"+sc.ID+"/rounds/r1/begin", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("begin round: %s", rec.Body.String())
	}

	mockReq := httptest.NewRequest("POST", "/mocks/"+sc.ID+"/op", strings.NewReader(`{"id":"new"}`))
	mockReq.Header.Set("X-Mock-Request-Id", "req-1")
	mockReq.Header.Set("X-Mock-Round-Id", "r1")
	mockRec := httptest.NewRecorder()
	h.ServeHTTP(mockRec, mockReq)
	if mockRec.Code != 201 {
		t.Fatalf("mock: %d %s", mockRec.Code, mockRec.Body.String())
	}
	got := fetchScenario(t, h, sc.ID)
	if len(got.Operations) != 1 || got.Operations[0].Status != "completed" || !got.Operations[0].Committed {
		t.Fatalf("operation not confirmed: %+v", got.Operations)
	}
	if got.State["v"] != "new" {
		t.Fatalf("state not committed: %v", got.State)
	}

	replayReq := httptest.NewRequest("POST", "/mocks/"+sc.ID+"/op", strings.NewReader(`{"id":"twice"}`))
	replayReq.Header.Set("X-Mock-Request-Id", "req-1")
	replayReq.Header.Set("X-Mock-Round-Id", "r1")
	replay := httptest.NewRecorder()
	h.ServeHTTP(replay, replayReq)
	if replay.Header().Get("X-Mock-Replayed-Fact") != "true" {
		t.Fatalf("duplicate request was executed again")
	}
	got = fetchScenario(t, h, sc.ID)
	if len(got.Operations) != 1 || got.State["v"] != "new" {
		t.Fatalf("idempotent fact changed runtime: %+v %v", got.Operations, got.State)
	}
}

func TestLateResultFromOldRoundDoesNotChangeCurrentVariables(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{"name":"late","initialState":{"v":"init"},"endpoints":[{"name":"e","method":"POST","path":"/late","defaultStatus":200,"defaultBody":"{}","rules":[{"id":"r","name":"r","enabled":true,"delayMs":25,"status":200,"body":"{}","extract":[{"from":"body","path":"v","key":"v"}]}]}]}`)
	enable(t, h, sc.ID)

	for _, round := range []string{"old", "new"} {
		req := httptest.NewRequest("POST", "/api/scenarios/"+sc.ID+"/rounds/"+round+"/begin", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
	}
	oldReq := httptest.NewRequest("POST", "/mocks/"+sc.ID+"/late", strings.NewReader(`{"v":"old-late"}`))
	oldReq.Header.Set("X-Mock-Request-Id", "old-req")
	oldReq.Header.Set("X-Mock-Round-Id", "old")
	h.ServeHTTP(httptest.NewRecorder(), oldReq)

	got := fetchScenario(t, h, sc.ID)
	if got.State["v"] != "init" {
		t.Fatalf("old round changed current state: %v", got.State)
	}
	if len(got.Operations) != 1 || got.Operations[0].Committed || got.Operations[0].UncommittedReason == "" {
		t.Fatalf("late result facts missing explanation: %+v", got.Operations)
	}
}

func TestTrackedCancellationStaysUnknownAndCanLaterBeConfirmed(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{store: store}
	h := s.routes()
	sc := createScenario(t, h, `{"name":"pending","initialState":{"v":"init"},"endpoints":[{"name":"e","method":"POST","path":"/slow","defaultStatus":200,"defaultBody":"{}","rules":[{"id":"r","name":"r","enabled":true,"delayMs":200,"status":200,"body":"{}","extract":[{"from":"body","path":"v","key":"v"}]}]}]}`)
	enable(t, h, sc.ID)
	beginReq := httptest.NewRequest("POST", "/api/scenarios/"+sc.ID+"/rounds/r1/begin", nil)
	beginRec := httptest.NewRecorder()
	h.ServeHTTP(beginRec, beginReq)

	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest("POST", "/mocks/"+sc.ID+"/slow", strings.NewReader(`{"v":"late"}`)).WithContext(ctx)
	req.Header.Set("X-Mock-Request-Id", "pending-req")
	req.Header.Set("X-Mock-Round-Id", "r1")
	done := make(chan struct{})
	go func() {
		h.ServeHTTP(httptest.NewRecorder(), req)
		close(done)
	}()
	time.Sleep(30 * time.Millisecond)
	cancel()
	time.Sleep(30 * time.Millisecond)
	got := fetchScenario(t, h, sc.ID)
	if len(got.Operations) != 1 || got.Operations[0].Status != "pending" {
		t.Fatalf("cancelled tracked request should remain pending/unknown: %+v", got.Operations)
	}
	if got.State["v"] != "init" {
		t.Fatalf("unknown request changed variables: %v", got.State)
	}
	select {
	case <-done:
	case <-time.After(300 * time.Millisecond):
		t.Fatal("late result was not finalized for inspectable facts")
	}
	got = fetchScenario(t, h, sc.ID)
	if len(got.Operations) != 1 || got.Operations[0].Status != "completed" || got.State["v"] != "late" {
		t.Fatalf("late completion not assigned to original round: %+v state=%v", got.Operations, got.State)
	}

	store2, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	h2 := (&Server{store: store2}).routes()
	reopened := fetchScenario(t, h2, sc.ID)
	if len(reopened.Operations) != 1 || reopened.Operations[0].Status != "completed" {
		t.Fatalf("reopened facts not persisted: %+v", reopened.Operations)
	}
	if _, err := os.Stat(filepath.Join(dir, sc.ID+".runtime.json")); err != nil {
		t.Fatalf("runtime facts missing: %v", err)
	}
}

func TestTrackedFailureIsConfirmedNotExecutedAgain(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{"name":"fail","initialState":{"v":"init"},"endpoints":[{"name":"e","method":"POST","path":"/fail","defaultStatus":200,"defaultBody":"{}","rules":[{"id":"r","name":"r","enabled":true,"status":200,"fail":{"kind":"reset"},"body":"","extract":[{"from":"body","path":"v","key":"v"}]}]}]}`)
	enable(t, h, sc.ID)
	beginReq := httptest.NewRequest("POST", "/api/scenarios/"+sc.ID+"/rounds/r1/begin", nil)
	beginRec := httptest.NewRecorder()
	h.ServeHTTP(beginRec, beginReq)
	req := httptest.NewRequest("POST", "/mocks/"+sc.ID+"/fail", strings.NewReader(`{"v":"bad"}`))
	req.Header.Set("X-Mock-Request-Id", "fail-req")
	req.Header.Set("X-Mock-Round-Id", "r1")
	h.ServeHTTP(httptest.NewRecorder(), req)
	got := fetchScenario(t, h, sc.ID)
	if got.State["v"] != "init" {
		t.Fatalf("failed operation changed state: %v", got.State)
	}
	if len(got.Operations) != 1 || got.Operations[0].Status != "failed" || got.Operations[0].Committed {
		t.Fatalf("failure not confirmed: %+v", got.Operations)
	}

	replayReq := httptest.NewRequest("POST", "/mocks/"+sc.ID+"/fail", strings.NewReader(`{"v":"again"}`))
	replayReq.Header.Set("X-Mock-Request-Id", "fail-req")
	replayReq.Header.Set("X-Mock-Round-Id", "r1")
	replay := httptest.NewRecorder()
	h.ServeHTTP(replay, replayReq)
	if replay.Code != http.StatusConflict {
		t.Fatalf("replaying confirmed failure status = %d", replay.Code)
	}
	got = fetchScenario(t, h, sc.ID)
	if len(got.Operations) != 1 || got.State["v"] != "init" {
		t.Fatalf("confirmed failure was resent: %+v state=%v", got.Operations, got.State)
	}
}
