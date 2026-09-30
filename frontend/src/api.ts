import type {
  Scenario,
  ValidationIssue,
  ValidateResponse,
} from "./types";

const BASE = "";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`) as Error & {
      status: number;
      data: unknown;
    };
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data as T;
}

// Normalize a scenario coming from the API so the UI never has to deal with
// null collections (Go serializes nil slices as null).
export function normalizeScenario(sc: Scenario): Scenario {
  return {
    ...sc,
    endpoints: (sc.endpoints ?? []).map((ep) => ({
      ...ep,
      rules: ep.rules ?? [],
    })),
    initialState: sc.initialState ?? {},
    history: sc.history ?? [],
    counters: sc.counters ?? {},
  };
}

export const api = {
  list: async () => {
    const data = await req<Scenario[] | null>("/api/scenarios");
    return (Array.isArray(data) ? data : []).map(normalizeScenario);
  },
  get: async (id: string) => normalizeScenario(await req<Scenario>(`/api/scenarios/${id}`)),
  create: async (sc: Partial<Scenario>) =>
    normalizeScenario(
      await req<Scenario>("/api/scenarios", { method: "POST", body: JSON.stringify(sc) })
    ),
  update: async (id: string, sc: Partial<Scenario>) =>
    normalizeScenario(
      await req<Scenario>(`/api/scenarios/${id}`, { method: "PUT", body: JSON.stringify(sc) })
    ),
  remove: (id: string) =>
    req<{ ok: boolean }>(`/api/scenarios/${id}`, { method: "DELETE" }),
  reset: async (id: string) =>
    normalizeScenario(
      await req<Scenario>(`/api/scenarios/${id}/reset`, { method: "POST" })
    ),
  validate: (id: string, sc: Partial<Scenario>) =>
    req<ValidateResponse>(`/api/scenarios/${id}/validate`, {
      method: "POST",
      body: JSON.stringify(sc),
    }),
  enable: (id: string) =>
    req<{ ok: boolean; issues: ValidationIssue[] }>(`/api/scenarios/${id}/enable`, {
      method: "POST",
    }),
};
