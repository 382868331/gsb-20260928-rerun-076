package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSeedDemoFlow(t *testing.T) {
	s := newTestServer(t)
	seedDemo(s.store)
	h := s.routes()
	sc := s.store.scenarios["sc-demo"]
	if sc == nil {
		t.Fatal("demo not seeded")
	}
	req := httptest.NewRequest("POST", "/api/scenarios/sc-demo/enable", nil)
	rw := httptest.NewRecorder()
	h.ServeHTTP(rw, req)
	if rw.Code != 200 {
		t.Fatalf("enable demo: %d %s", rw.Code, rw.Body.String())
	}

	call := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/mocks/sc-demo/orders", strings.NewReader(body))
		r := httptest.NewRecorder()
		h.ServeHTTP(r, req)
		return r
	}
	r1 := call(`{"id":"O-1"}`)
	if r1.Code != 503 {
		t.Fatalf("first = %d %s", r1.Code, r1.Body.String())
	}
	r2 := call(`{"id":"O-1"}`)
	if r2.Code != 201 {
		t.Fatalf("second = %d %s", r2.Code, r2.Body.String())
	}
	greq := httptest.NewRequest("GET", "/mocks/sc-demo/orders/abc", nil)
	gr := httptest.NewRecorder()
	h.ServeHTTP(gr, greq)
	if !strings.Contains(gr.Body.String(), `"lastCreated":"O-1"`) {
		t.Fatalf("state not used in later call: %s", gr.Body.String())
	}
}
