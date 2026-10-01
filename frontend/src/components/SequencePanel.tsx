import { useRef, useState } from "react";
import { api } from "../api";
import type { Scenario } from "../types";
import { diffState, findStateRefs, substituteState } from "../sequence";

export interface SeqStep {
  id: string;
  label: string;
  method: string;
  path: string; // may contain {{state.key}} templates
  query: string;
  headersText: string;
  bodyText: string;
}

export type StepStatus =
  | "ok"
  | "failed"
  | "cancelled"
  | "skipped"
  | "invalid";

export interface StepResult {
  status: StepStatus;
  httpStatus?: number;
  ms?: number;
  error?: string;
  note?: string;
  consumed?: { key: string; source: string | null }[];
  produced?: Record<string, unknown>;
  missing?: string[];
}

const STATUS_TEXT: Record<StepStatus, string> = {
  ok: "已完成",
  failed: "失败",
  cancelled: "已取消",
  skipped: "未执行",
  invalid: "变量失效",
};

export function SequencePanel({
  scenario,
  steps,
  setSteps,
  onRefresh,
}: {
  scenario: Scenario;
  steps: SeqStep[];
  setSteps: (s: SeqStep[]) => void;
  onRefresh: () => void;
}) {
  const [results, setResults] = useState<Record<string, StepResult>>({});
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const update = (id: string, patch: Partial<SeqStep>) =>
    setSteps(steps.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const run = async () => {
    if (running || steps.length === 0) return;
    setRunning(true);
    setResults({});
    const abort = new AbortController();
    abortRef.current = abort;
    const out: Record<string, StepResult> = {};
    try {
      // Always start from a clean slate so values from previous runs
      // cannot leak into this one.
      const fresh = await api.reset(scenario.id);
      let state: Record<string, unknown> = fresh.state ?? {};
      const producedBy = new Map<string, string>();
      for (const k of Object.keys(state)) producedBy.set(k, "初始状态");

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (abort.signal.aborted) {
          out[step.id] = { status: "cancelled", note: "执行已取消" };
          continue;
        }
        const allText = [step.path, step.query, step.headersText, step.bodyText].join("\n");
        const refs = findStateRefs(allText);
        const consumed = refs.map((key) => ({
          key,
          source: producedBy.get(key) ?? null,
        }));
        const missing = consumed.filter((c) => c.source === null).map((c) => c.key);
        if (missing.length > 0) {
          out[step.id] = {
            status: "invalid",
            consumed,
            missing,
            note: `变量 ${missing.join("、")} 在本次运行中没有来源（可能来自上次成功运行，已失效）`,
          };
          markRemaining(i + 1, out, `第 ${i + 1} 步变量失效，未执行`);
          break;
        }
        const sub = (t: string) => substituteState(t, state).text;
        let headers: Record<string, string> = {};
        try {
          headers = JSON.parse(sub(step.headersText) || "{}");
        } catch {
          out[step.id] = { status: "failed", consumed, error: "请求头不是合法 JSON" };
          markRemaining(i + 1, out, `第 ${i + 1} 步失败，未执行`);
          break;
        }
        const hasBody = !["GET", "HEAD"].includes(step.method);
        const body = hasBody && sub(step.bodyText) ? sub(step.bodyText) : undefined;
        const query = sub(step.query).trim().replace(/^[?]/, "");
        const url =
          `/mocks/${scenario.id}${sub(step.path)}` +
          (query ? (sub(step.path).includes("?") ? "&" : "?") + query : "");
        const started = performance.now();
        try {
          const res = await fetch(url, {
            method: step.method,
            headers,
            body,
            signal: abort.signal,
          });
          await res.text();
          const ms = Math.round(performance.now() - started);
          const after = await api.get(scenario.id);
          const newState: Record<string, unknown> = after.state ?? {};
          const produced = diffState(state, newState);
          for (const k of Object.keys(produced)) producedBy.set(k, `第 ${i + 1} 步`);
          state = newState;
          out[step.id] = { status: "ok", httpStatus: res.status, ms, consumed, produced };
        } catch (e) {
          const cancelled = abort.signal.aborted;
          out[step.id] = {
            status: cancelled ? "cancelled" : "failed",
            consumed,
            error: cancelled
              ? "已取消"
              : e instanceof Error
              ? e.message
              : String(e),
            note: cancelled
              ? "取消的请求不会写入场景状态"
              : "失败的请求不会写入场景状态，后续步骤不能沿用本次之前的值",
          };
          markRemaining(i + 1, out, cancelled ? "执行已取消" : `第 ${i + 1} 步失败，未执行`);
          break;
        }
        setResults({ ...out });
      }
      setResults({ ...out });
    } catch (e) {
      out[steps[0]?.id ?? ""] = {
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
      };
      setResults({ ...out });
    } finally {
      setRunning(false);
      abortRef.current = null;
      onRefresh();
    }
  };

  const markRemaining = (from: number, out: Record<string, StepResult>, note: string) => {
    for (let j = from; j < steps.length; j++) {
      out[steps[j].id] = { status: "skipped", note };
    }
  };

  const cancel = () => abortRef.current?.abort();

  return (
    <div className="sequence">
      <div className="row-between">
        <h4>序列执行（按顺序重放，变量只取本次运行产生的值）</h4>
        <div className="seq-actions">
          {!running && (
            <button
              className="btn primary"
              onClick={run}
              disabled={steps.length === 0 || !scenario.enabled}
            >
              执行序列（先重置状态）
            </button>
          )}
          {running && (
            <button className="btn danger" onClick={cancel}>
              取消执行
            </button>
          )}
          <button
            className="btn-mini"
            disabled={running || steps.length === 0}
            onClick={() => {
              setSteps([]);
              setResults({});
            }}
          >
            清空
          </button>
        </div>
      </div>
      <p className="muted small">
        每次执行前会先重置场景状态与计数；某一步失败或被取消后，后续步骤不再执行，
        也不会沿用本次运行之前留下的任何值。请求中可用 {"{{state.键}}"} 引用前面步骤写入的状态。
      </p>
      {steps.length === 0 && (
        <p className="muted">还没有步骤。用上方“加入序列”把当前请求加入，或在调用历史里勾选一段请求重新执行。</p>
      )}
      {steps.map((step, i) => {
        const r = results[step.id];
        return (
          <div key={step.id} className={`seq-step seq-${r?.status ?? "idle"}`}>
            <div className="seq-head">
              <span className="seq-num">#{i + 1}</span>
              <strong>
                {step.method} {step.path}
              </strong>
              <span className="muted small">{step.label}</span>
              {r && (
                <span className={`seq-badge seq-badge-${r.status}`}>
                  {STATUS_TEXT[r.status]}
                  {r.httpStatus !== undefined && ` · HTTP ${r.httpStatus}`}
                  {r.ms !== undefined && ` · ${r.ms}ms`}
                </span>
              )}
              <button
                className="btn-mini danger"
                disabled={running}
                onClick={() => setSteps(steps.filter((s) => s.id !== step.id))}
              >
                移除
              </button>
            </div>
            <details className="seq-edit">
              <summary>查看 / 修改请求</summary>
              <label className="block">
                路径（可用 {"{{state.键}}"}）
                <input value={step.path} disabled={running} onChange={(e) => update(step.id, { path: e.target.value })} />
              </label>
              <label className="block">
                Query
                <input value={step.query} disabled={running} onChange={(e) => update(step.id, { query: e.target.value })} />
              </label>
              <label className="block">
                请求头 JSON
                <textarea rows={2} value={step.headersText} disabled={running} spellCheck={false}
                  onChange={(e) => update(step.id, { headersText: e.target.value })} />
              </label>
              {!["GET", "HEAD"].includes(step.method) && (
                <label className="block">
                  请求体
                  <textarea rows={4} value={step.bodyText} disabled={running} spellCheck={false}
                    onChange={(e) => update(step.id, { bodyText: e.target.value })} />
                </label>
              )}
            </details>
            {r && (
              <div className="seq-result">
                {r.consumed && r.consumed.length > 0 && (
                  <div className="seq-vars">
                    <span className="muted small">本次变量来源：</span>
                    {r.consumed.map((c) => (
                      <span key={c.key} className={c.source ? "var-chip" : "var-chip invalid"}>
                        {c.key} ← {c.source ?? "失效（本次运行无来源）"}
                      </span>
                    ))}
                  </div>
                )}
                {r.produced && Object.keys(r.produced).length > 0 && (
                  <div className="seq-vars">
                    <span className="muted small">本步写入：</span>
                    {Object.entries(r.produced).map(([k, v]) => (
                      <span key={k} className="var-chip produced">
                        {k} = {JSON.stringify(v)}
                      </span>
                    ))}
                  </div>
                )}
                {r.error && <div className="resp-error">{r.error}</div>}
                {r.note && <div className="muted small">{r.note}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
