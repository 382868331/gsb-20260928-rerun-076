package expr

import "testing"

func TestEval(t *testing.T) {
	c := &Context{
		Body:  map[string]any{"name": "alice", "age": float64(30), "tags": []any{"x", "y"}},
		Query: map[string]any{"page": "2"},
		State: map[string]any{"count": float64(4)},
		Calls: 3,
	}
	cases := []struct {
		expr string
		want any
	}{
		{"body.name", "alice"},
		{"body.age + 1", float64(31)},
		{"state.count * 2", float64(8)},
		{"calls == 3", true},
		{"body.age > 20 && body.name == \"alice\"", true},
		{"length(body.tags)", float64(2)},
		{"concat(\"a\", body.name, 1)", "aalice1"},
		{"query.page == 2", true},
		{"if(body.age >= 18, \"adult\", \"kid\")", "adult"},
		{"body.missing == null", true},
	}
	for _, tc := range cases {
		got, err := Eval(tc.expr, c)
		if err != nil {
			t.Fatalf("%s: %v", tc.expr, err)
		}
		if got != tc.want {
			t.Fatalf("%s = %v (%T), want %v (%T)", tc.expr, got, got, tc.want, tc.want)
		}
	}
}

func TestRender(t *testing.T) {
	c := &Context{
		Body:  map[string]any{"id": "abc"},
		State: map[string]any{"n": float64(2)},
		Query: map[string]any{}, Headers: map[string]any{}, Path: map[string]any{},
	}
	out, err := Render(`{"id":"{{body.id}}","n":{{state.n + 1}}}`, c)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"abc","n":3}`
	if out != want {
		t.Fatalf("got %s want %s", out, want)
	}
}

func TestRenderErrors(t *testing.T) {
	c := emptyTestContext()
	if _, err := Render(`{{ 1 + }}`, c); err == nil {
		t.Fatal("expected parse error")
	}
	if _, err := Render(`{{ state.x `, c); err == nil {
		t.Fatal("expected unterminated error")
	}
}

func emptyTestContext() *Context {
	return &Context{
		Body: map[string]any{}, Query: map[string]any{}, Headers: map[string]any{},
		Path: map[string]any{}, State: map[string]any{},
	}
}
