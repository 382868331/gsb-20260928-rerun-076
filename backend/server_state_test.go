package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReplaceStateEndpoint(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := &Server{store: store}
	sc := Scenario{ID: "sc-1", Name: "s", Endpoints: []Endpoint{}, InitialState: map[string]interface{}{"a": 1}}
	if _, err := store.upsert(sc); err != nil {
		t.Fatal(err)
	}
	h := srv.routes()
	req := httptest.NewRequest("PUT", "/api/scenarios/sc-1/state", strings.NewReader(`{"b":2}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	got, _ := store.get("sc-1")
	if got.State["b"] != float64(2) {
		t.Fatalf("state not replaced: %v", got.State)
	}
	if _, ok := got.State["a"]; ok {
		t.Fatalf("old keys must be dropped, got %v", got.State)
	}
	// persisted definition must not contain runtime state
	store2, err := NewStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	reloaded, _ := store2.get("sc-1")
	if _, ok := reloaded.State["b"]; ok {
		t.Fatal("runtime state must not be persisted")
	}
}
