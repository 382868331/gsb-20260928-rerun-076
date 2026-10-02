package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateReturnsEmptySliceNotNil(t *testing.T) {
	sc := Scenario{
		ID:   "sc-ok",
		Name: "ok",
		Endpoints: []Endpoint{{
			ID: "ep-1", Name: "e", Method: "GET", Path: "/x",
			DefaultStatus: 200, DefaultBody: "{}", Rules: []Rule{},
		}},
		InitialState: map[string]interface{}{},
	}
	issues := validateScenario(&sc)
	if issues == nil {
		t.Fatal("issues must never be nil")
	}
	b, _ := json.Marshal(map[string]interface{}{"issues": issues, "valid": true})
	if !strings.Contains(string(b), `"issues":[]`) {
		t.Fatalf("empty issues must serialize as [], got %s", b)
	}
}
