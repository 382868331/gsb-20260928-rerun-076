// Helpers for chaining requests: request fields may reference scenario
// state via {{state.key}} and earlier steps via {{step.N.key}} /
// {{step.N[i].key}}. These helpers resolve references, track where each
// variable came from, and detect values that are no longer valid — values
// from a previous run or from a branch that did not run are never reused.

const REF_RE =
  /{{\s*(state|step)\.([\w.\[\]-]+?)(?:\s*\?\?\s*(?:"[^"]*"|'[^']*'))?\s*}}/g;

// findRefs returns every {{state.x}} / {{step.N.x}} reference, in
// first-seen order, as full tokens like "state.x" or "step.2[3].token".
export function findRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(REF_RE)) {
    const full = m[1] + "." + m[2];
    if (!out.includes(full)) out.push(full);
  }
  return out;
}

export function findStateRefs(text: string): string[] {
  return findRefs(text)
    .filter((r) => r.startsWith("state."))
    .map((r) => r.slice("state.".length));
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

// RunScope is the variable pool of one execution round: the scenario state
// built so far plus the values each step produced, kept per repetition so
// later steps can reference a specific run of a repeated step.
export interface RunScope {
  state: Record<string, unknown>;
  steps: Record<number, Record<string, unknown>[]>; // 1-based step no -> per-repetition produced values
}

export function emptyScope(state: Record<string, unknown>): RunScope {
  return { state, steps: {} };
}

// resolveRef resolves "state.key" or "step.N.key" / "step.N[i].key"
// (1-based; without [i] the last completed repetition is used).
export function resolveRef(ref: string, scope: RunScope): unknown {
  if (ref.startsWith("state.")) {
    return lookup(scope.state, ref.slice("state.".length));
  }
  const m = /^step\.(\d+)(?:\[(\d+)\])?\.(.+)$/.exec(ref);
  if (!m) return undefined;
  const n = Number(m[1]);
  const reps = scope.steps[n];
  if (!reps || reps.length === 0) return undefined;
  const idx = m[2] !== undefined ? Number(m[2]) - 1 : reps.length - 1;
  const values = reps[idx];
  if (!values) return undefined;
  return lookup(values, m[3]);
}

export interface Substitution {
  text: string;
  refs: string[];    // every reference, in first-seen order
  missing: string[]; // referenced but unresolvable in this scope
}

// substitute replaces {{state.x}} / {{step.N.x}} tokens using only the
// scope given here. Missing values render as empty and are reported, so
// callers never silently fall back to values left over from an earlier
// run or from a branch that did not execute.
export function substitute(text: string, scope: RunScope): Substitution {
  const refs: string[] = [];
  const missing: string[] = [];
  const out = text.replace(REF_RE, (_whole, ns: string, key: string) => {
    const full = ns + "." + key;
    if (!refs.includes(full)) refs.push(full);
    const value = resolveRef(full, scope);
    if (value === undefined) {
      if (!missing.includes(full)) missing.push(full);
      return "";
    }
    return render(value);
  });
  return { text: out, refs, missing };
}

// substituteState keeps the original state-only behaviour used by the
// single-request panel.
export function substituteState(
  text: string,
  state: Record<string, unknown>
): Substitution {
  const sub = substitute(text, emptyScope(state));
  const strip = (r: string) => (r.startsWith("state.") ? r.slice(6) : r);
  return { text: sub.text, refs: sub.refs.map(strip), missing: sub.missing.map(strip) };
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

// ---- step conditions -------------------------------------------------

export interface CondResult {
  pass: boolean | null; // null = cannot be decided (a referenced variable has no source)
  missing: string[];    // references that made the condition undecidable
}

function truthy(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "" && v !== false && v !== 0;
}

// evalCondition evaluates a branch condition against the current scope.
// Syntax: "key" (truthy), "!key" (falsy), "key == value", "key != value";
// the key may be a bare state key, state.key, or step.N[i].key. A condition
// that depends on a variable with no source (e.g. its producer failed or
// was cancelled) is undecidable and returns pass === null so the caller can
// stop that branch explicitly instead of guessing.
export function evalCondition(expr: string, scope: RunScope): CondResult {
  const trimmed = expr.trim();
  if (!trimmed) return { pass: true, missing: [] };
  const cmp = /^(.+?)\s*(==|!=)\s*(.*)$/.exec(trimmed);
  let refToken: string;
  let op: string | null = null;
  let expected = "";
  if (cmp && !cmp[1].trim().startsWith("!")) {
    refToken = cmp[1].trim();
    op = cmp[2];
    expected = cmp[3].trim().replace(/^(['"])(.*)\1$/, "$2");
  } else if (trimmed.startsWith("!")) {
    refToken = trimmed.slice(1).trim();
  } else {
    refToken = trimmed;
  }
  const ref = /^(state|step)\./.test(refToken) ? refToken : "state." + refToken;
  const value = resolveRef(ref, scope);
  if (value === undefined) {
    return { pass: null, missing: [ref] };
  }
  if (op === "==") return { pass: render(value) === expected, missing: [] };
  if (op === "!=") return { pass: render(value) !== expected, missing: [] };
  const pass = trimmed.startsWith("!") ? !truthy(value) : truthy(value);
  return { pass, missing: [] };
}

// ---- bounded repetition ----------------------------------------------

export const MAX_REPEAT = 10;

export function clampRepeat(n: number | undefined): number {
  if (!n || !Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_REPEAT, Math.floor(n));
}

// ---- re-run from the middle ------------------------------------------

export interface RerunStepInfo {
  id: string;
  condition?: string;
  repeat?: number;
}

export interface RerunResultInfo {
  status: string;
  completedRepeats?: number;
}

export interface Preflight {
  from: number; // 1-based step number the re-run starts at
  reAcquire: { step: number; conditions: string[]; refs: string[] }[];
  stalePreconditions: number[]; // earlier steps modified after they last ran
  partialRepeats: { step: number; done: number; total: number }[];
  discarded: number[]; // steps whose previous-round results will be dropped
}

// planRerun computes what a re-run starting at step "from" (1-based) must
// re-obtain and what it invalidates, so the user can confirm before values
// from different execution rounds get mixed.
export function planRerun(
  steps: RerunStepInfo[],
  results: Record<string, RerunResultInfo | undefined>,
  edited: ReadonlySet<string>,
  texts: Record<string, string>,
  from: number
): Preflight {
  const stalePreconditions: number[] = [];
  const partialRepeats: { step: number; done: number; total: number }[] = [];
  for (let i = 0; i < from - 1; i++) {
    const s = steps[i];
    const r = results[s.id];
    if (!r || edited.has(s.id)) stalePreconditions.push(i + 1);
    const total = clampRepeat(s.repeat);
    if (r && r.completedRepeats !== undefined && r.completedRepeats < total) {
      partialRepeats.push({ step: i + 1, done: r.completedRepeats, total });
    }
  }
  const reAcquire: Preflight["reAcquire"] = [];
  const discarded: number[] = [];
  for (let i = from - 1; i < steps.length; i++) {
    const s = steps[i];
    const conditions = s.condition?.trim() ? [s.condition.trim()] : [];
    const refs = findRefs(texts[s.id] ?? "");
    reAcquire.push({ step: i + 1, conditions, refs });
    if (results[s.id]) discarded.push(i + 1);
  }
  return { from, reAcquire, stalePreconditions, partialRepeats, discarded };
}

// rebuildScope reconstructs the variable pool at the start of step "upto"
// (1-based, exclusive) from the kept results of earlier steps, so a re-run
// from the middle continues from this round's own values only.
export function rebuildScope(
  initialState: Record<string, unknown>,
  stepIds: string[],
  produced: Record<string, Record<string, unknown>[] | undefined>,
  upto: number
): RunScope {
  const scope = emptyScope(JSON.parse(JSON.stringify(initialState ?? {})));
  for (let i = 0; i < upto - 1 && i < stepIds.length; i++) {
    const reps = produced[stepIds[i]];
    if (!reps || reps.length === 0) continue;
    scope.steps[i + 1] = reps.map((p) => ({ ...p }));
    for (const p of reps) Object.assign(scope.state, p);
  }
  return scope;
}
