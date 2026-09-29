package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestServer(t *testing.T) *Server {
	t.Helper()
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &Server{store: store}
}

func createScenario(t *testing.T, h http.Handler, body string) Scenario {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/scenarios", strings.NewReader(body))
	recw := httptest.NewRecorder()
	h.ServeHTTP(recw, req)
	if recw.Code != 201 {
		t.Fatalf("create: %d %s", recw.Code, recw.Body.String())
	}
	var sc Scenario
	if err := json.Unmarshal(recw.Body.Bytes(), &sc); err != nil {
		t.Fatal(err)
	}
	return sc
}

func enable(t *testing.T, h http.Handler, id string) {
	req := httptest.NewRequest("POST", "/api/scenarios/"+id+"/enable", nil)
	recw := httptest.NewRecorder()
	h.ServeHTTP(recw, req)
	if recw.Code != 200 {
		t.Fatalf("enable: %d %s", recw.Code, recw.Body.String())
	}
}

func TestStatefulChainAcrossRequests(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{
	  "name": "order flow",
	  "initialState": {"count": 0},
	  "endpoints": [
	    {"name":"create","method":"POST","path":"/orders","defaultStatus":201,
	     "rules":[{"id":"r1","name":"ok","enabled":true,"status":201,
	       "body":"{\"id\":\"{{body.id}}\",\"seq\":{{state.count}}}",
	       "extract":[{"from":"body","path":"id","key":"lastId"}]}]},
	    {"name":"get","method":"GET","path":"/orders/:id","defaultStatus":200,
	     "defaultBody":"{\"id\":{{path.id}}}"}
	  ]
	}`)
	enable(t, h, sc.ID)

	req := httptest.NewRequest("POST", "/mocks/"+sc.ID+"/orders", strings.NewReader(`{"id":"A-1"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if strings.TrimSpace(rec.Body.String()) != `{"id":"A-1","seq":0}` {
		t.Fatalf("create resp = %q", rec.Body.String())
	}

	req = httptest.NewRequest("GET", "/mocks/"+sc.ID+"/orders/B-2", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), `"id":B-2`) {
		t.Fatalf("get resp = %q", rec.Body.String())
	}

	greq := httptest.NewRequest("GET", "/api/scenarios/"+sc.ID, nil)
	grec := httptest.NewRecorder()
	h.ServeHTTP(grec, greq)
	var got Scenario
	_ = json.Unmarshal(grec.Body.Bytes(), &got)
	if got.State["lastId"] != "A-1" {
		t.Fatalf("lastId = %v", got.State["lastId"])
	}
	if len(got.History) != 2 {
		t.Fatalf("history len = %d", len(got.History))
	}
}

func TestNthCallAndCondition(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{
	  "name":"retry",
	  "endpoints":[{"name":"pay","method":"POST","path":"/pay","defaultStatus":200,"defaultBody":"{\"ok\":true}",
	    "rules":[
	      {"id":"r1","name":"first fails","enabled":true,"nthCall":1,"status":500,"body":"{\"error\":\"busy\"}"},
	      {"id":"r2","name":"vip","enabled":true,"priority":10,"status":202,
	       "condition":{"body":[{"path":"tier","op":"eq","value":"vip"}]},
	       "body":"{\"accepted\":true}"}
	    ]
	  }]
	}`)
	enable(t, h, sc.ID)
	call := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/mocks/"+sc.ID+"/pay", strings.NewReader(body))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	r1 := call(`{"tier":"normal"}`)
	if r1.Code != 500 {
		t.Fatalf("first call = %d", r1.Code)
	}
	r2 := call(`{"tier":"normal"}`)
	if r2.Code != 200 {
		t.Fatalf("second normal call = %d", r2.Code)
	}
	r3 := call(`{"tier":"vip"}`)
	if r3.Code != 202 || !strings.Contains(r3.Body.String(), "accepted") {
		t.Fatalf("vip call = %d %s", r3.Code, r3.Body.String())
	}
}

func TestResetOnlyAffectsCurrentScenario(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	def := `{"name":"%s","initialState":{"k":"init"},"endpoints":[{"name":"e","method":"POST","path":"/x","defaultStatus":200,"defaultBody":"{}","rules":[{"id":"r","name":"r","enabled":true,"status":200,"body":"{}","extract":[{"from":"body","path":"v","key":"k"}]}]}]}`
	a := createScenario(t, h, fmt.Sprintf(def, "a"))
	b := createScenario(t, h, fmt.Sprintf(def, "b"))
	enable(t, h, a.ID)
	enable(t, h, b.ID)
	fire := func(id string) {
		req := httptest.NewRequest("POST", "/mocks/"+id+"/x", strings.NewReader(`{"v":"changed"}`))
		h.ServeHTTP(httptest.NewRecorder(), req)
	}
	fire(a.ID)
	fire(b.ID)
	req := httptest.NewRequest("POST", "/api/scenarios/"+a.ID+"/reset", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("reset: %s", rec.Body.String())
	}
	var ar Scenario
	_ = json.Unmarshal(rec.Body.Bytes(), &ar)
	if ar.State["k"] != "init" {
		t.Fatalf("a state after reset = %v", ar.State)
	}
	if len(ar.History) != 0 || len(ar.Counters) != 0 {
		t.Fatalf("a runtime not cleared: %+v", ar)
	}
	get := s.store.scenarios[b.ID]
	if get.State["k"] != "changed" {
		t.Fatalf("b state leaked: %v", get.State)
	}
}

func TestConflictBlocksEnable(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{"name":"c","endpoints":[{"name":"e","method":"GET","path":"/x","defaultStatus":200,"defaultBody":"{}","rules":[
	  {"id":"r1","name":"r1","enabled":true,"status":200,"body":"a"},
	  {"id":"r2","name":"r2","enabled":true,"status":201,"body":"b"}
	]}]}`)
	req := httptest.NewRequest("POST", "/api/scenarios/"+sc.ID+"/enable", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 409 {
		t.Fatalf("enable status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestPersistenceReload(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	h := (&Server{store: store}).routes()
	sc := createScenario(t, h, `{"name":"persist","endpoints":[{"name":"e","method":"GET","path":"/y","defaultStatus":200,"defaultBody":"{\"v\":1}"}]}`)
	b, err := os.ReadFile(filepath.Join(dir, sc.ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte("history")) {
		t.Fatalf("runtime fields persisted: %s", b)
	}
	store2, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	got := store2.scenarios[sc.ID]
	if got == nil || len(got.Endpoints) != 1 {
		t.Fatalf("reload failed: %v", got)
	}
}

func TestResetConnectionFailure(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Skipf("cannot listen in this sandbox: %v", r)
		}
	}()
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{"name":"f","endpoints":[{"name":"e","method":"POST","path":"/z","defaultStatus":200,"defaultBody":"{}","rules":[{"id":"r","name":"r","enabled":true,"delayMs":10,"status":0,"fail":{"kind":"reset"},"body":""}]}]}`)
	enable(t, h, sc.ID)
	srv := httptest.NewServer(h)
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/mocks/"+sc.ID+"/z", "application/json", strings.NewReader(`{}`))
	if err == nil {
		resp.Body.Close()
		t.Fatalf("expected connection error, got response")
	}
}
