import type { Endpoint, Rule, Scenario } from "./types";

let counter = 0;
function cid(prefix: string): string {
  counter += 1;
  return `${prefix}-new-${Date.now().toString(36)}-${counter}`;
}

export function newEndpoint(): Endpoint {
  return {
    id: cid("ep"),
    name: "新端点",
    method: "GET",
    path: "/api/resource",
    defaultStatus: 200,
    defaultHeaders: {},
    defaultBody: '{ "ok": true }',
    rules: [],
  };
}

export function newRule(): Rule {
  return {
    id: cid("rule"),
    name: "新规则",
    enabled: true,
    priority: 0,
    nthCall: 0,
    delayMs: 0,
    status: 200,
    headers: {},
    body: '{}',
    extract: [],
  };
}

export function newScenario(): Scenario {
  return {
    id: "",
    name: "新场景",
    description: "",
    enabled: false,
    endpoints: [newEndpoint()],
    initialState: {},
    createdAt: "",
    updatedAt: "",
  };
}

// The backend may serialize empty collections as null; the UI iterates
// these fields, so normalize them at the API boundary.
export function ensureCollections(sc: Scenario): Scenario {
  return {
    ...sc,
    endpoints: (sc.endpoints ?? []).map((ep) => ({ ...ep, rules: ep.rules ?? [] })),
    initialState: sc.initialState ?? {},
    state: sc.state ?? {},
    counters: sc.counters ?? {},
    history: sc.history ?? [],
  };
}
