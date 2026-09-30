import type { Endpoint } from "./types";

// ---- 链式调试：有先后依赖的请求序列 -------------------------------------
// 每一步可以引用前序步骤提取出的变量（{{key}} 语法），
// 变量只在“本次执行”内有效：每次运行都从空的变量表开始，
// 失败 / 取消 / 编辑前置步骤都会使后续结果失效，不会沿用上次成功的值。

export interface ChainExtract {
  path: string; // 响应体 JSON 点路径，如 data.id
  key: string; // 写入的变量名
}

export interface ChainStep {
  id: string;
  endpointId: string;
  pathVars: Record<string, string>; // 路径参数，可含 {{key}}
  query: string; // 可含 {{key}}
  headersText: string; // JSON 文本，可含 {{key}}
  bodyText: string; // 可含 {{key}}
  extracts: ChainExtract[];
}

export interface UsedVar {
  key: string;
  fromStep: number; // 0 基步骤序号
}

export interface StepResult {
  runId: number;
  executed: boolean;
  ok: boolean;
  status: number; // 0 表示未发出 / 传输失败
  ms: number;
  body: string;
  error?: string; // 失败原因（传输失败、变量缺失、提取失败、HTTP 错误）
  skipped?: string; // 未执行原因（不在区间 / 前置失败 / 已取消）
  usedVars: UsedVar[]; // 本步实际用到的变量及来源
  missingVars: string[]; // 本步需要但本次执行中没有的变量
  produced: string[]; // 本步提取出的变量名
}

export interface VarEntry {
  key: string;
  value: unknown;
  fromStep: number;
  runId: number;
}

export interface Invalidation {
  key: string;
  atStep: number; // 变量缺失 / 失效的位置（0 基步骤序号）
  reason: string;
}

export interface ChainRunOutput {
  runId: number;
  results: Record<string, StepResult>;
  variables: Record<string, VarEntry>;
  invalidations: Invalidation[];
  halted: boolean;
  cancelled: boolean;
}

let stepCounter = 0;
export function newChainStep(endpointId = ""): ChainStep {
  stepCounter += 1;
  return {
    id: `step-${Date.now().toString(36)}-${stepCounter}`,
    endpointId,
    pathVars: {},
    query: "",
    headersText: '{"Content-Type":"application/json"}',
    bodyText: "",
    extracts: [],
  };
}

const VAR_RE = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

/** 替换模板中的 {{key}}，返回替换结果与缺失的变量名。 */
export function substitute(
  tpl: string,
  vars: Record<string, VarEntry>
): { out: string; missing: string[] } {
  const missing = new Set<string>();
  const out = tpl.replace(VAR_RE, (full, key: string) => {
    const entry = vars[key];
    if (!entry) {
      missing.add(key);
      return full;
    }
    const v = entry.value;
    return typeof v === "string" ? v : JSON.stringify(v);
  });
  return { out, missing: [...missing] };
}

/** 收集一步中引用到的全部变量名。 */
export function stepVarRefs(step: ChainStep): string[] {
  const refs = new Set<string>();
  const scan = (text: string) => {
    for (const m of text.matchAll(VAR_RE)) refs.add(m[1]);
  };
  Object.values(step.pathVars).forEach(scan);
  scan(step.query);
  scan(step.headersText);
  scan(step.bodyText);
  return [...refs];
}

/** 按点路径从 JSON 值中取值；路径不存在返回 undefined。 */
export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".").filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (typeof cur === "object") {
      if (!(seg in (cur as Record<string, unknown>))) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function buildUrl(
  scenarioId: string,
  endpoint: Endpoint,
  pathVars: Record<string, string>,
  query: string
): string {
  let path = endpoint.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) =>
    encodeURIComponent(pathVars[name] ?? `:${name}`)
  );
  const q = query.trim().replace(/^[?]/, "");
  if (q) path += (path.includes("?") ? "&" : "?") + q;
  return `/mocks/${scenarioId}${path}`;
}

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init?: RequestInit
) => Promise<FetchLikeResponse>;

function blankResult(runId: number, skipped: string): StepResult {
  return {
    runId,
    executed: false,
    ok: false,
    status: 0,
    ms: 0,
    body: "",
    skipped,
    usedVars: [],
    missingVars: [],
    produced: [],
  };
}

/**
 * 顺序执行 [from, to] 区间内的步骤。
 * 变量表每次调用都从零开始；任何一步失败或外部取消都会停止后续步骤，
 * 并记录后续步骤因哪些变量失效而无法执行。
 */
export async function runChain(args: {
  steps: ChainStep[];
  endpoints: Endpoint[];
  scenarioId: string;
  from: number;
  to: number;
  runId: number;
  fetchFn: FetchLike;
  isCancelled?: () => boolean;
  onProgress?: (out: ChainRunOutput) => void;
}): Promise<ChainRunOutput> {
  const { steps, endpoints, scenarioId, from, to, runId, fetchFn } = args;
  const cancelled = () => args.isCancelled?.() ?? false;
  const out: ChainRunOutput = {
    runId,
    results: {},
    variables: {},
    invalidations: [],
    halted: false,
    cancelled: false,
  };
  const progress = () => args.onProgress?.(out);

  let haltReason = "";
  let haltStep = -1;

  const recordInvalidations = (stepIndex: number, reason: string) => {
    for (const key of stepVarRefs(steps[stepIndex])) {
      if (!out.variables[key]) {
        out.invalidations.push({ key, atStep: stepIndex, reason });
      }
    }
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (i < from || i > to) {
      out.results[step.id] = blankResult(runId, "不在本次执行区间内");
      continue;
    }
    if (out.halted || cancelled()) {
      if (!out.halted) {
        out.cancelled = true;
        out.halted = true;
        haltReason = "已取消";
        haltStep = i - 1;
      }
      out.results[step.id] = blankResult(
        runId,
        haltStep >= 0
          ? `第 ${haltStep + 1} 步${haltReason}，本步未执行`
          : `执行已${haltReason}，本步未执行`
      );
      recordInvalidations(i, `第 ${haltStep + 1} 步${haltReason}，变量未产生`);
      progress();
      continue;
    }

    const ep = endpoints.find((e) => e.id === step.endpointId);
    if (!ep) {
      out.results[step.id] = {
        ...blankResult(runId, ""),
        executed: true,
        error: "端点已失效（可能已被删除），请重新选择端点",
      };
      out.halted = true;
      haltReason = "失败";
      haltStep = i;
      recordInvalidations(i, "端点已失效");
      continue;
    }

    // 变量替换：只使用本次执行中提取到的变量
    const usedVars: UsedVar[] = [];
    const missingAll = new Set<string>();
    const sub = (text: string) => {
      const r = substitute(text, out.variables);
      r.missing.forEach((k) => missingAll.add(k));
      return r.out;
    };
    const pathVars: Record<string, string> = {};
    for (const [k, v] of Object.entries(step.pathVars)) pathVars[k] = sub(v);
    const query = sub(step.query);
    const headersText = sub(step.headersText);
    const bodyText = sub(step.bodyText);
    for (const key of stepVarRefs(step)) {
      const entry = out.variables[key];
      if (entry) usedVars.push({ key, fromStep: entry.fromStep });
    }

    const started = performance.now();
    const fail = (error: string, extra?: Partial<StepResult>) => {
      out.results[step.id] = {
        runId,
        executed: true,
        ok: false,
        status: extra?.status ?? 0,
        ms: Math.round(performance.now() - started),
        body: extra?.body ?? "",
        error,
        usedVars,
        missingVars: [...missingAll],
        produced: [],
      };
      out.halted = true;
      haltReason = "失败";
      haltStep = i;
      for (const key of missingAll) {
        out.invalidations.push({ key, atStep: i, reason: "本次执行中该变量未产生" });
      }
      progress();
    };

    if (missingAll.size > 0) {
      fail(`缺少变量：${[...missingAll].join("、")}（本次执行中没有前序步骤提供）`);
      continue;
    }

    let reqHeaders: Record<string, string> = {};
    try {
      reqHeaders = headersText.trim() ? JSON.parse(headersText) : {};
    } catch {
      fail("请求头不是合法 JSON");
      continue;
    }

    const url = buildUrl(scenarioId, ep, pathVars, query);
    const hasBody = !["GET", "HEAD"].includes(ep.method);
    let res: FetchLikeResponse;
    try {
      res = await fetchFn(url, {
        method: ep.method,
        headers: reqHeaders,
        body: hasBody && bodyText ? bodyText : undefined,
      });
    } catch (e) {
      fail(`传输层失败：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const body = await res.text();
    if (!res.ok) {
      fail(`HTTP ${res.status}`, { status: res.status, body });
      continue;
    }

    // 提取变量：提取失败同样阻断后续步骤，避免把旧值带下去
    const produced: string[] = [];
    let extractError = "";
    if (step.extracts.length > 0) {
      let parsed: unknown;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {
        extractError = "响应体不是合法 JSON，无法提取变量";
      }
      if (!extractError) {
        for (const ex of step.extracts) {
          if (!ex.key.trim()) continue;
          const value = getPath(parsed, ex.path);
          if (value === undefined) {
            extractError = `提取失败：响应中不存在路径 ${ex.path}`;
            break;
          }
          out.variables[ex.key] = { key: ex.key, value, fromStep: i, runId };
          produced.push(ex.key);
        }
      }
    }
    if (extractError) {
      fail(extractError, { status: res.status, body });
      continue;
    }

    out.results[step.id] = {
      runId,
      executed: true,
      ok: true,
      status: res.status,
      ms: Math.round(performance.now() - started),
      body,
      usedVars,
      missingVars: [],
      produced,
    };
    progress();
  }
  progress();
  return out;
}

/**
 * 修改第 index 步（或在其前插入）后，使该步及后续步骤的结果与
 * 由它们产生的变量失效，避免旧结果混入下一次过程。
 */
export function invalidateFrom(
  out: ChainRunOutput,
  steps: ChainStep[],
  index: number
): ChainRunOutput {
  const results: Record<string, StepResult> = {};
  steps.forEach((s, i) => {
    if (i < index && out.results[s.id]) results[s.id] = out.results[s.id];
  });
  const variables: Record<string, VarEntry> = {};
  for (const [k, v] of Object.entries(out.variables)) {
    if (v.fromStep < index) variables[k] = v;
  }
  const invalidations = out.invalidations.filter((iv) => iv.atStep < index);
  return { ...out, results, variables, invalidations };
}
