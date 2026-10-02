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

export const api = {
  list: () => req<Scenario[]>('/api/scenarios'),
  get: (id: string) => req<Scenario>(`/api/scenarios/${id}`),
  create: (sc: Partial<Scenario>) =>
    req<Scenario>("/api/scenarios", { method: "POST", body: JSON.stringify(sc) }),
  update: (id: string, sc: Partial<Scenario>) =>
    req<Scenario>(`/api/scenarios/${id}`, { method: "PUT", body: JSON.stringify(sc) }),
  remove: (id: string) =>
    req<{ ok: boolean }>(`/api/scenarios/${id}`, { method: "DELETE" }),
  reset: (id: string) => req<Scenario>(`/api/scenarios/${id}/reset`, { method: "POST" }),
  setState: (id: string, state: Record<string, unknown>) =>
    req<Scenario>(`/api/scenarios/${id}/state`, {
      method: "PUT",
      body: JSON.stringify(state),
    }),
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
