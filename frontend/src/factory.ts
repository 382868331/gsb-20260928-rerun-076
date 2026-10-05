import type { Endpoint, Rule, Scenario } from "./types";

let counter = 0;
export function localId(prefix: string): string {
  counter += 1;
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

function cid(prefix: string): string {
  return localId(prefix);
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
    clientId: localId("draft"),
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
  const condition = (cond: NonNullable<import("./types").Rule>["condition"]) => {
    if (!cond) return undefined;
    return {
      headers: cond.headers ?? {},
      queries: cond.queries ?? {},
      body: cond.body ?? [],
    };
  };
  return {
    ...sc,
    endpoints: (sc.endpoints ?? []).map((ep) => ({
      ...ep,
      defaultHeaders: ep.defaultHeaders ?? {},
      rules: (ep.rules ?? []).map((rule) => ({
        ...rule,
        headers: rule.headers ?? {},
        extract: rule.extract ?? [],
        condition: condition(rule.condition),
      })),
    })),
    initialState: sc.initialState ?? {},
    state: sc.state ?? {},
    counters: sc.counters ?? {},
    history: sc.history ?? [],
    operations: sc.operations ?? [],
  };
}
