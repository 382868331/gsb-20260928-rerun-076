package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestListEmptyReturnsJSONArray(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/scenarios", nil)
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("empty list should be [], got %q", rec.Body.String())
	}
}

func TestScenarioWithoutEndpointsSerializesEmptyArray(t *testing.T) {
	s := newTestServer(t)
	body := `{"name":"空场景","description":""}`
	req := httptest.NewRequest(http.MethodPost, "/api/scenarios", strings.NewReader(body))
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, req)
	if rec.Code != 201 {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var created map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	eps, ok := created["endpoints"].([]interface{})
	if !ok || eps == nil {
		t.Fatalf("endpoints should be a JSON array, got %#v", created["endpoints"])
	}
	id, _ := created["id"].(string)
	if id == "" {
		t.Fatal("missing id")
	}
	req2 := httptest.NewRequest(http.MethodGet, "/api/scenarios/"+id, nil)
	rec2 := httptest.NewRecorder()
	s.routes().ServeHTTP(rec2, req2)
	var got map[string]interface{}
	if err := json.Unmarshal(rec2.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if _, ok := got["endpoints"].([]interface{}); !ok {
		t.Fatalf("reloaded endpoints should be a JSON array, got %#v", got["endpoints"])
	}
}
