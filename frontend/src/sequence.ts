// Helpers for chaining requests: request fields may reference scenario
// state via {{state.key}}; these helpers resolve references, track where
// each variable came from, and detect values that are no longer valid.

const STATE_REF_RE = /{{\s*state\.([\w.\[\]-]+?)(?:\s*\?\?\s*(?:"[^"]*"|'[^']*'))?\s*}}/g;

export function findStateRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(STATE_REF_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function lookup(state: Record<string, unknown>, key: string): unknown {
  const segments = key.split(".");
  let cur: unknown = state;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function render(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export interface Substitution {
  text: string;
  refs: string[];    // every {{state.key}} referenced, in first-seen order
  missing: string[]; // referenced but absent from the provided state
}

// substituteState replaces {{state.key}} tokens using only the state given
// here. Missing keys render as empty and are reported, so callers never
// silently fall back to values left over from an earlier run.
export function substituteState(
  text: string,
  state: Record<string, unknown>
): Substitution {
  const refs: string[] = [];
  const missing: string[] = [];
  const out = text.replace(STATE_REF_RE, (whole, key: string) => {
    if (!refs.includes(key)) refs.push(key);
    const value = lookup(state, key);
    if (value === undefined) {
      if (!missing.includes(key)) missing.push(key);
      return "";
    }
    return render(value);
  });
  return { text: out, refs, missing };
}

// diffState returns the keys whose values were added or changed between
// two state snapshots (i.e. what one request produced).
export function diffState(
  prev: Record<string, unknown>,
  next: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    if (!(k in prev) || JSON.stringify(prev[k]) !== JSON.stringify(v)) {
      out[k] = v;
    }
  }
  return out;
}

// ---------- execution rounds (条件分支 / 有限重复 / 暂停审阅 / 中断恢复) ----------

import type { CallRecord } from "./types";

export interface SeqStep {
  id: string;
  label: string;
  method: string;
  path: string; // may contain {{state.key}} templates
  query: string;
  headersText: string;
  bodyText: string;
  conditionText: string; // "" = always run; otherwise a template that must render truthy
  repeatCount: number; // bounded repetition, 1..MAX_REPEAT
  pauseAfter: boolean; // pause for manual review after this step
}

export const MAX_REPEAT = 20;

export function clampRepeat(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_REPEAT, Math.floor(n));
}

export function newSeqStep(partial: Partial<SeqStep> & Pick<SeqStep, "id" | "label" | "method" | "path">): SeqStep {
  return {
    query: "",
    headersText: "{}",
    bodyText: "",
    conditionText: "",
    repeatCount: 1,
    pauseAfter: false,
    ...partial,
  };
}

export interface ConditionOutcome {
  run: boolean;
  rendered: string;
  refs: string[];
  missing: string[];
}

// evalCondition renders the condition template against the visible state.
// Missing variables render empty and therefore fail closed: a branch whose
// inputs do not exist in this round is simply not taken, never fed by
// stale values from an earlier round.
export function evalCondition(text: string, state: Record<string, unknown>): ConditionOutcome {
  if (!text.trim()) return { run: true, rendered: "", refs: [], missing: [] };
  const sub = substituteState(text, state);
  const v = sub.text.trim().toLowerCase();
  const falsy = v === "" || v === "false" || v === "0" || v === "null";
  return { run: !falsy, rendered: sub.text, refs: sub.refs, missing: sub.missing };
}

export type RepStatus = "ok" | "failed" | "cancelled";

export interface RepResult {
  n: number;
  status: RepStatus;
  httpStatus?: number;
  ms?: number;
  error?: string;
  duplicate?: boolean; // server replayed an earlier response for the same request id
  requestId: string;
  produced?: Record<string, unknown>;
}

export type StepRunStatus =
  | "ok"
  | "failed"
  | "cancelled"
  | "skipped" // never reached in this round (earlier step stopped the run)
  | "invalid" // variables unavailable in this round
  | "skipped-branch" // condition evaluated to false in this round
  | "sent" // request sent, response not (yet) recorded — outcome uncertain
  | "terminated"; // user terminated this path after an uncertain outcome

export interface StepRoundResult {
  status: StepRunStatus;
  branch?: { text: string; taken: boolean; rendered: string; missing: string[] };
  consumed?: { key: string; source: string | null }[];
  produced?: Record<string, unknown>;
  missing?: string[];
  repetitions?: RepResult[];
  requestId?: string; // in-flight request id, used to reconcile after a reload
  httpStatus?: number;
  ms?: number;
  error?: string;
  note?: string;
}

export interface RunRound {
  id: string;
  no: number; // 1-based display number
  kind: "full" | "continuation";
  startedAt: string;
  status: "running" | "paused" | "done" | "interrupted" | "aborted";
  fromStep: number; // first step index executed by this round
  results: Record<string, StepRoundResult>;
  keptFromRound?: number; // round no whose independent prefix results were kept
}

// visibleState restricts a state snapshot to keys with a known source in
// the current round, so values produced by an old round can never leak
// into substitutions of the new one.
export function visibleState(
  state: Record<string, unknown>,
  knownKeys: Iterable<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of knownKeys) {
    if (k in state) out[k] = state[k];
  }
  return out;
}

export type Reconciled =
  | { kind: "confirmed-done"; record: CallRecord }
  | { kind: "confirmed-not-executed"; record?: CallRecord; reason: string }
  | { kind: "uncertain" };

// reconcileRequest classifies a sent-but-unconfirmed request against the
// server-side history (the saved facts): completed, provably not executed,
// or still uncertain (it may arrive late).
export function reconcileRequest(
  requestId: string | undefined,
  history: CallRecord[]
): Reconciled {
  if (!requestId) {
    return { kind: "confirmed-not-executed", reason: "请求从未发出" };
  }
  const record = history.find((c) => c.requestId === requestId);
  if (!record) return { kind: "uncertain" };
  if (record.cancelled) {
    return { kind: "confirmed-not-executed", record, reason: "请求被取消，服务端确认未写入状态" };
  }
  if (record.failed) {
    return { kind: "confirmed-not-executed", record, reason: "请求失败（" + record.failed.kind + "），服务端确认未写入状态" };
  }
  return { kind: "confirmed-done", record };
}

export interface ResumeImpact {
  conditions: { stepIndex: number; text: string }[];
  variables: { key: string; source: string | null; refetch: boolean }[];
  keptSteps: number[];
}

// analyzeResume lists what must be re-acquired before continuing from
// `fromIndex` after the user edited preconditions: every condition that
// has to be re-judged and every variable consumed downstream, marking
// whether its producer is being re-run (must be re-fetched) or belongs to
// the kept independent prefix.
export function analyzeResume(
  steps: SeqStep[],
  fromIndex: number,
  producedByStep: Record<string, number>
): ResumeImpact {
  const conditions: ResumeImpact["conditions"] = [];
  const variables: ResumeImpact["variables"] = [];
  const seen = new Set<string>();
  for (let i = fromIndex; i < steps.length; i++) {
    const s = steps[i];
    if (s.conditionText.trim()) {
      conditions.push({ stepIndex: i, text: s.conditionText });
    }
    const refs = findStateRefs(
      [s.path, s.query, s.headersText, s.bodyText, s.conditionText].join("\n")
    );
    for (const key of refs) {
      if (seen.has(key)) continue;
      seen.add(key);
      const producer = producedByStep[key];
      variables.push({
        key,
        source: producer !== undefined ? `第 ${producer + 1} 步` : null,
        refetch: producer === undefined || producer >= fromIndex,
      });
    }
  }
  const keptSteps: number[] = [];
  for (let i = 0; i < fromIndex; i++) keptSteps.push(i);
  return { conditions, variables, keptSteps };
}

