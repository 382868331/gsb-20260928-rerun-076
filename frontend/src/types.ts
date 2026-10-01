export interface Condition {
  headers?: Record<string, string>;
  queries?: Record<string, string>;
  body?: BodyMatcher[];
}

export interface BodyMatcher {
  path: string;
  op: "eq" | "ne" | "exists";
  value?: unknown;
}

export interface Extract {
  from: "body" | "header" | "query" | "path";
  path: string;
  key: string;
}

export interface Failure {
  kind: "reset" | "timeout";
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  nthCall: number;
  condition?: Condition;
  delayMs: number;
  fail?: Failure;
  status: number;
  headers?: Record<string, string>;
  body: string;
  extract?: Extract[];
}

export interface Endpoint {
  id: string;
  name: string;
  method: string;
  path: string;
  defaultStatus: number;
  defaultHeaders?: Record<string, string>;
  defaultBody: string;
  rules: Rule[];
}

export interface CallRecord {
  seq: number;
  time: string;
  endpointId: string;
  method: string;
  path: string;
  ruleId: string;
  status: number;
  failed?: Failure;
  cancelled?: boolean;
  delayMs: number;
  reqHeaders?: Record<string, string>;
  reqQuery?: Record<string, string>;
  reqBody?: unknown;
  stateAfter?: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  endpoints: Endpoint[];
  initialState: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  state?: Record<string, unknown>;
  counters?: Record<string, number>;
  history?: CallRecord[];
}

export interface ValidationIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  endpoint?: string;
  rule?: string;
}

export interface ValidateResponse {
  issues: ValidationIssue[];
  valid: boolean;
}
