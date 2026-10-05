package main

// Condition constrains when a rule fires. All configured fields must match
// (AND semantics); multiple values inside one field are OR.
type Condition struct {
	Headers map[string]string `json:"headers"` // required request headers (exact, case-insensitive keys)
	Queries map[string]string `json:"queries"` // required query parameters (exact)
	Body    []BodyMatcher     `json:"body"`    // JSONPath-like assertions against the request body
}

// BodyMatcher compares a value extracted from the JSON request body.
type BodyMatcher struct {
	Path  string      `json:"path"`  // dot path, e.g. user.id; numbers index arrays
	Op    string      `json:"op"`    // eq | ne | exists
	Value interface{} `json:"value"` // expected value for eq/ne
}

// Extract copies a value from the current request into scenario state.
type Extract struct {
	From string `json:"from"` // body | header | query
	Path string `json:"path"` // dot path for body, key name otherwise
	Key  string `json:"key"`  // state key to write
}

// Rule describes one possible behavior of an endpoint.
type Rule struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Enabled   bool              `json:"enabled"`
	Priority  int               `json:"priority"` // larger wins
	NthCall   int               `json:"nthCall"`  // >0: only fires on this 1-based call number
	Condition *Condition        `json:"condition,omitempty"`
	DelayMS   int               `json:"delayMs"`
	Fail      *Failure          `json:"fail,omitempty"`
	Status    int               `json:"status"`
	Headers   map[string]string `json:"headers,omitempty"`
	Body      string            `json:"body"`
	Extract   []Extract         `json:"extract,omitempty"`
}

// Failure simulates transport-level problems.
type Failure struct {
	Kind string `json:"kind"` // reset | timeout
}

type Endpoint struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	Method         string            `json:"method"`
	Path           string            `json:"path"` // may contain :param segments
	DefaultStatus  int               `json:"defaultStatus"`
	DefaultHeaders map[string]string `json:"defaultHeaders,omitempty"`
	DefaultBody    string            `json:"defaultBody"`
	Rules          []Rule            `json:"rules"`
}

type Scenario struct {
	ID           string                 `json:"id"`
	ClientID     string                 `json:"clientId,omitempty"`
	Name         string                 `json:"name"`
	Description  string                 `json:"description"`
	Enabled      bool                   `json:"enabled"`
	Endpoints    []Endpoint             `json:"endpoints"`
	InitialState map[string]interface{} `json:"initialState"`
	CreatedAt    string                 `json:"createdAt"`
	UpdatedAt    string                 `json:"updatedAt"`
	ContentHash  string                 `json:"contentHash,omitempty"`

	// runtime state, included in API responses but stripped when persisting
	State         map[string]interface{} `json:"state,omitempty"`
	Counters      map[string]int         `json:"counters,omitempty"` // endpointID -> number of calls
	History       []CallRecord           `json:"history,omitempty"`
	ActiveRoundID string                 `json:"activeRoundId,omitempty"`
	Operations    []OperationRecord      `json:"operations,omitempty"`
}

// OperationRecord is a durable fact about one logical request attempt. It is
// written before the request leaves the planner, so a process/browser
// interruption can be reopened as "unknown" instead of being silently retried.
type OperationRecord struct {
	RequestID         string                 `json:"requestId"`
	RoundID           string                 `json:"roundId"`
	StepID            string                 `json:"stepId,omitempty"`
	BranchID          string                 `json:"branchId,omitempty"`
	Condition         string                 `json:"condition,omitempty"`
	RepeatIndex       int                    `json:"repeatIndex,omitempty"`
	Attempt           int                    `json:"attempt,omitempty"`
	Status            string                 `json:"status"` // pending | completed | failed
	StartedAt         string                 `json:"startedAt"`
	CompletedAt       string                 `json:"completedAt,omitempty"`
	EndpointID        string                 `json:"endpointId"`
	Method            string                 `json:"method"`
	Path              string                 `json:"path"`
	RuleID            string                 `json:"ruleId,omitempty"`
	StatusHTTP        int                    `json:"statusHttp,omitempty"`
	ReqHeaders        map[string]string      `json:"reqHeaders,omitempty"`
	ReqQuery          map[string]string      `json:"reqQuery,omitempty"`
	ReqBody           interface{}            `json:"reqBody,omitempty"`
	StateBefore       map[string]interface{} `json:"stateBefore,omitempty"`
	ProposedState     map[string]interface{} `json:"proposedState,omitempty"`
	Committed         bool                   `json:"committed,omitempty"`
	UncommittedReason string                 `json:"uncommittedReason,omitempty"`
	ResponseBody      string                 `json:"responseBody,omitempty"`
}

type CallRecord struct {
	Seq        int                    `json:"seq"`
	Time       string                 `json:"time"`
	EndpointID string                 `json:"endpointId"`
	Method     string                 `json:"method"`
	Path       string                 `json:"path"`
	RuleID     string                 `json:"ruleId"` // "" means default response
	Status     int                    `json:"status"` // 0 when transport failed
	Failed     *Failure               `json:"failed,omitempty"`
	Cancelled  bool                   `json:"cancelled,omitempty"` // client went away mid-delay; state not committed
	DelayMS    int                    `json:"delayMs"`
	ReqHeaders map[string]string      `json:"reqHeaders,omitempty"`
	ReqQuery   map[string]string      `json:"reqQuery,omitempty"`
	ReqBody    interface{}            `json:"reqBody,omitempty"`
	StateAfter map[string]interface{} `json:"stateAfter,omitempty"`
}

type ValidationIssue struct {
	Level    string `json:"level"` // error | warning
	Code     string `json:"code"`
	Message  string `json:"message"`
	Endpoint string `json:"endpoint,omitempty"`
	Rule     string `json:"rule,omitempty"`
}
