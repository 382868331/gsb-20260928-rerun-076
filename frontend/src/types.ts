export interface Condition {
  field: string;
  op: string;
  value?: unknown;
}

export interface Failure {
  type: "http_error" | "timeout" | "disconnect";
  status?: number;
  message?: string;
  timeoutMs?: number;
}

export interface Operation {
  target: string;
  op: "set" | "increment" | "unset";
  value?: string;
}

export interface ResponseDef {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

export interface Rule {
  id: string;
  endpointId: string;
  name: string;
  enabled: boolean;
  priority: number;
  conditions: Condition[];
  delayMs: number;
  failure?: Failure | null;
  response: ResponseDef;
  operations: Operation[];
}

export interface Endpoint {
  id: string;
  name: string;
  method: string;
  path: string;
  enabled: boolean;
}

export interface Scenario {
  id: string;
  name: string;
  description?: string;
  initialVars?: Record<string, unknown>;
  endpoints: Endpoint[];
  rules: Rule[];
  createdAt?: string;
  updatedAt?: string;
}

export interface Issue {
  level: "error" | "warning";
  code: string;
  message: string;
  target?: string;
}

export interface HistoryEntry {
  seq: number;
  at: string;
  method: string;
  path: string;
  status: number;
  matchedRuleId?: string;
  delayMs: number;
  failure?: string;
  elapsedMs: number;
  reqHeaders?: Record<string, string>;
  reqBody?: string;
  respHeaders?: Record<string, string>;
  respBody?: string;
}

export interface RunState {
  vars: Record<string, unknown>;
  counters: Record<string, number>;
  seq: number;
  history: HistoryEntry[];
}
