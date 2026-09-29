package validate

import (
	"strings"
	"testing"

	"mockplatform/internal/model"
)

func TestConflictAndErrors(t *testing.T) {
	sc := &model.Scenario{
		Name: "x",
		Endpoints: []model.Endpoint{
			{ID: "ep1", Name: "a", Method: "POST", Path: "/a", Enabled: true},
		},
		Rules: []model.Rule{
			{ID: "r1", EndpointID: "ep1", Enabled: true, Priority: 1,
				Response: model.ResponseDef{Status: 200, Body: `{}`}},
			{ID: "r2", EndpointID: "ep1", Enabled: true, Priority: 2,
				Response: model.ResponseDef{Status: 200, Body: `{}`}},
		},
	}
	issues := Check(sc)
	foundShadow, foundUnreachable := false, false
	for _, is := range issues {
		if is.Code == "RULE_SHADOWS" {
			foundShadow = true
		}
		if is.Code == "RULE_UNREACHABLE" {
			foundUnreachable = true
		}
	}
	if !foundShadow || !foundUnreachable {
		t.Fatalf("expected shadow + unreachable, got %+v", issues)
	}
}

func TestDuplicateConditions(t *testing.T) {
	sc := &model.Scenario{
		Name:      "x",
		Endpoints: []model.Endpoint{{ID: "ep1", Name: "a", Method: "GET", Path: "/a", Enabled: true}},
		Rules: []model.Rule{
			{ID: "r1", EndpointID: "ep1", Enabled: true, Priority: 1,
				Conditions: []model.Condition{{Field: "query.kind", Op: "eq", Value: "vip"}},
				Response:   model.ResponseDef{Status: 200, Body: "{}"}},
			{ID: "r2", EndpointID: "ep1", Enabled: true, Priority: 2,
				Conditions: []model.Condition{{Field: "query.kind", Op: "eq", Value: "vip"}},
				Response:   model.ResponseDef{Status: 200, Body: "{}"}},
		},
	}
	issues := Check(sc)
	ok := false
	for _, is := range issues {
		if is.Code == "RULE_DUPLICATE_CONDITIONS" && strings.Contains(is.Target, "r2") {
			ok = true
		}
	}
	if !ok {
		t.Fatalf("expected duplicate-conditions error: %+v", issues)
	}
}

func TestValidScenario(t *testing.T) {
	sc := &model.Scenario{
		Name:      "ok",
		Endpoints: []model.Endpoint{{ID: "ep1", Name: "a", Method: "POST", Path: "/orders/{id}", Enabled: true}},
		Rules: []model.Rule{
			{ID: "r1", EndpointID: "ep1", Enabled: true, Priority: 1,
				Conditions: []model.Condition{{Field: "body.x", Op: "gt", Value: 1}},
				Operations: []model.Operation{{Target: "state.id", Op: "set", Value: "body.x"}},
				Response:   model.ResponseDef{Status: 200, Body: `{"id":{{body.x}}}`}},
		},
	}
	if HasErrors(Check(sc)) {
		t.Fatalf("valid scenario flagged: %+v", Check(sc))
	}
}
