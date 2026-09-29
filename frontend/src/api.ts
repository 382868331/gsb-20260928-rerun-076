import type { Issue, RunState, Scenario } from "./types";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  list: () => req<Scenario[]>("/api/scenarios"),
  get: (id: string) => req<Scenario>(`/api/scenarios/${id}`),
  create: (sc: Scenario) =>
    req<Scenario>("/api/scenarios", { method: "POST", body: JSON.stringify(sc) }),
  update: (id: string, sc: Scenario) =>
    req<Scenario>(`/api/scenarios/${id}`, { method: "PUT", body: JSON.stringify(sc) }),
  remove: (id: string) =>
    req<{ deleted: string }>(`/api/scenarios/${id}`, { method: "DELETE" }),
  validate: (id: string, sc: Scenario) =>
    req<{ issues: Issue[]; canEnable: boolean }>(`/api/scenarios/${id}/validate`, {
      method: "POST",
      body: JSON.stringify(sc),
    }),
  state: (id: string) => req<RunState>(`/api/scenarios/${id}/state`),
  reset: (id: string) =>
    req<RunState>(`/api/scenarios/${id}/reset`, { method: "POST" }),
};

export interface MockResult {
  status: number;
  ok: boolean;
  text: string;
  durationMs: number;
  networkError?: string;
}

export async function sendMock(
  scenarioId: string,
  method: string,
  pathWithQuery: string,
  body: string,
  headers: Record<string, string>,
): Promise<MockResult> {
  const start = performance.now();
  try {
    const methodUpper = method.toUpperCase();
    const hasBody = !!body && methodUpper !== "GET" && methodUpper !== "HEAD";
    const res = await fetch(`/m/${scenarioId}${pathWithQuery}`, {
      method,
      headers: { ...headers, ...(hasBody ? { "Content-Type": "application/json" } : {}) },
      body: hasBody ? body : undefined,
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, durationMs: Math.round(performance.now() - start) };
  } catch (err) {
    return {
      status: 0,
      ok: false,
      text: "",
      durationMs: Math.round(performance.now() - start),
      networkError: err instanceof Error ? err.message : String(err),
    };
  }
}
