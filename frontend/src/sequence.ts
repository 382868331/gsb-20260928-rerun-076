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
