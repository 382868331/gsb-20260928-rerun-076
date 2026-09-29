package model

// Scenario is the saved design unit. Scenarios are fully isolated at runtime.
type Scenario struct {
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	Description string                 `json:"description,omitempty"`
	InitialVars map[string]any         `json:"initialVars,omitempty"`
	Endpoints   []Endpoint             `json:"endpoints"`
	Rules       []Rule                 `json:"rules"`
	CreatedAt   string                 `json:"createdAt"`
	UpdatedAt   string                 `json:"updatedAt"`
	Extra       map[string]interface{} `json:"-"`
}

type Endpoint struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Method  string `json:"method"`
	Path    string `json:"path"` // e.g. /orders/{id}
	Enabled bool   `json:"enabled"`
}

type Condition struct {
	Field string `json:"field"` // body.x / query.x / headers.x / path.x / state.x / calls
	Op    string `json:"op"`    // eq ne gt gte lt lte exists contains in
	Value any    `json:"value,omitempty"`
}

type Failure struct {
	Type      string `json:"type"` // http_error | timeout | disconnect
	Status    int    `json:"status,omitempty"`
	Message   string `json:"message,omitempty"`
	TimeoutMs int    `json:"timeoutMs,omitempty"`
}

type Operation struct {
	Target string `json:"target"`          // state.foo
	Op     string `json:"op"`              // set | increment | unset
	Value  string `json:"value,omitempty"` // expression, e.g. body.name or state.count + 1
}

type ResponseDef struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body"` // templated text, typically JSON
}

type Rule struct {
	ID         string      `json:"id"`
	EndpointID string      `json:"endpointId"`
	Name       string      `json:"name"`
	Enabled    bool        `json:"enabled"`
	Priority   int         `json:"priority"`
	Conditions []Condition `json:"conditions"`
	DelayMs    int         `json:"delayMs"`
	Failure    *Failure    `json:"failure,omitempty"`
	Response   ResponseDef `json:"response"`
	Operations []Operation `json:"operations"`
}

type Issue struct {
	Level   string `json:"level"` // error | warning
	Code    string `json:"code"`
	Message string `json:"message"`
	Target  string `json:"target,omitempty"` // rule id / endpoint id
}

type HistoryEntry struct {
	Seq           int               `json:"seq"`
	At            string            `json:"at"`
	Method        string            `json:"method"`
	Path          string            `json:"path"`
	Status        int               `json:"status"`
	MatchedRuleID string            `json:"matchedRuleId,omitempty"`
	DelayMs       int               `json:"delayMs"`
	Failure       string            `json:"failure,omitempty"`
	ElapsedMs     int64             `json:"elapsedMs"`
	ReqHeaders    map[string]string `json:"reqHeaders,omitempty"`
	ReqBody       string            `json:"reqBody,omitempty"`
	RespHeaders   map[string]string `json:"respHeaders,omitempty"`
	RespBody      string            `json:"respBody,omitempty"`
}

type RunState struct {
	Vars     map[string]any `json:"vars"`
	Counters map[string]int `json:"counters"` // endpointID -> calls
	Seq      int            `json:"seq"`
	History  []HistoryEntry `json:"history"`
}
