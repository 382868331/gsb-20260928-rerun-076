// Client-side mirror of the backend {{...}} template expansion, used when
// replaying saved sequences so later steps can reference state produced by
// earlier steps (e.g. PUT body containing {{state.orderId}}).

export type TemplateState = Record<string, unknown>;

function resolvePath(v: unknown, path: string): unknown {
  let cur: unknown = v;
  for (const seg of path.split(".")) {
    if (seg === "") return undefined;
    if (cur && typeof cur === "object") {
      if (Array.isArray(cur)) {
        const i = Number(seg);
        if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined;
        cur = cur[i];
      } else {
        if (!(seg in (cur as Record<string, unknown>))) return undefined;
        cur = (cur as Record<string, unknown>)[seg];
      }
    } else {
      return undefined;
    }
  }
  return cur;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const tokenRe = /{{\s*([a-zA-Z]+)\.([\w.\[\]-]+?)\s*(?:\?\?\s*("[^"]*"|'[^']*'))?\s*}}/g;

export function expandTemplate(
  tpl: string,
  state: TemplateState,
  extra?: Partial<Record<"body" | "header" | "query" | "path", Record<string, unknown>>>
): string {
  return tpl.replace(tokenRe, (m, source: string, key: string, fallback?: string) => {
  let val: unknown;
  let has = false;
  if (source === "state") {
    const v = resolvePath(state, key);
    has = v !== undefined;
    val = v;
  } else if (source === "callNumber" && key === "n") {
    return "0";
  } else if (extra && (source === "body" || source === "header" || source === "query" || source === "path")) {
    const v = resolvePath(extra[source] ?? {}, key);
    has = v !== undefined;
    val = v;
  }
  if (!has) {
    if (fallback) return fallback.slice(1, -1);
    return "";
  }
  return stringify(val);
  });
}

export function containsTemplate(s: string): boolean {
  return /{{\s*[a-zA-Z]+\./.test(s);
}
