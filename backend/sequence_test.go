package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestSequenceSaveDoesNotResetRuntime(t *testing.T) {
	s := newTestServer(t)
	h := s.routes()
	sc := createScenario(t, h, `{"name":"seq","endpoints":[{"name":"e","method":"GET","path":"/q","defaultStatus":200,"defaultBody":"{}"}]}`)
	enable(t, h, sc.ID)

	// Produce some runtime state/history.
	req := httptest.NewRequest("GET", "/mocks/"+sc.ID+"/q", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	seqBody := `{"name":"s1","steps":[{"endpointId":"` + sc.Endpoints[0].ID + `","method":"GET","path":"/q"}]}`
	req2 := httptest.NewRequest("POST", "/api/scenarios/"+sc.ID+"/sequences", strings.NewReader(seqBody))
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, req2)
	if w2.Code != 200 {
		t.Fatalf("save sequence: %d %s", w2.Code, w2.Body.String())
	}
	var got Scenario
	if err := json.Unmarshal(w2.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Sequences) != 1 || got.Sequences[0].Name != "s1" {
		t.Fatalf("sequence not attached: %+v", got.Sequences)
	}
	if len(got.History) != 1 {
		t.Fatalf("saving a sequence must not reset history, got %d records", len(got.History))
	}
	if got.Counters[sc.Endpoints[0].ID] != 1 {
		t.Fatalf("counters were reset by sequence save: %+v", got.Counters)
	}

	// Persisted to disk and survives reload.
	b, err := os.ReadFile(s.store.dir + "/" + sc.ID + ".json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "s1") {
		t.Fatalf("sequence not persisted: %s", b)
	}
}

func TestStateDotPathRendering(t *testing.T) {
	c := renderContext{state: map[string]interface{}{
		"order": map[string]interface{}{"id": "abc"},
	}}
	out, _ := renderTemplate(`{"id":"{{state.order.id}}"}`, c)
	if !strings.Contains(out, "abc") {
		t.Fatalf("dot path not resolved: %s", out)
	}
}

func TestInvalidPathSegmentRejected(t *testing.T) {
	sc := &Scenario{
		Endpoints: []Endpoint{{Method: "GET", Path: "/bad seg", DefaultStatus: 200}},
	}
	issues := validateScenario(sc)
	found := false
	for _, is := range issues {
		if is.Code == "endpoint.path" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected path validation error for '/bad seg', got %+v", issues)
	}
}
