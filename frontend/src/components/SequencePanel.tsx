import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { Scenario } from "../types";
import {
  MAX_REPEAT,
  clampRepeat,
  diffState,
  evalCondition,
  findStateRefs,
  newSeqStep,
  reconcileRequest,
  analyzeResume,
  substituteState,
  visibleState,
  type RepResult,
  type RunRound,
  type SeqStep,
  type StepRoundResult,
} from "../sequence";

export type { SeqStep } from "../sequence";
export { newSeqStep } from "../sequence";

const STATUS_TEXT: Record<StepRoundResult["status"], string> = {
  ok: "已完成",
  failed: "失败",
  cancelled: "已取消",
  skipped: "未执行",
  invalid: "变量失效",
  "skipped-branch": "分支未选中",
  sent: "结果未确认",
  terminated: "已终止",
};

const ROUND_STATUS_TEXT: Record<RunRound["status"], string> = {
  running: "执行中",
  paused: "已暂停（等待审阅）",
  done: "已完成",
  interrupted: "被中断",
  aborted: "已终止",
};

interface Persisted {
  steps: SeqStep[];
  rounds: RunRound[];
}

const storageKey = (scenarioId: string) => "msq:" + scenarioId;

function loadPersisted(scenarioId: string): Persisted | null {
  try {
    const raw = localStorage.getItem(storageKey(scenarioId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Persisted;
    if (!Array.isArray(parsed.steps) || !Array.isArray(parsed.rounds)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function savePersisted(scenarioId: string, p: Persisted) {
  try {
    localStorage.setItem(storageKey(scenarioId), JSON.stringify(p));
  } catch {
    /* storage full or unavailable: rounds still live in memory */
  }
}

function markRemaining(
  round: RunRound,
  steps: SeqStep[],
  from: number,
  note: string
) {
  for (let j = from; j < steps.length; j++) {
    if (!round.results[steps[j].id]) {
      round.results[steps[j].id] = { status: "skipped", note };
    }
  }
}

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
  const [rounds, setRounds] = useState<RunRound[]>([]);
  const [running, setRunning] = useState(false);
  const [staleFrom, setStaleFrom] = useState<number | null>(null);
  const [waiting, setWaiting] = useState<Record<string, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);
  const resumeRef = useRef<(() => void) | null>(null);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const roundsRef = useRef(rounds);
  roundsRef.current = rounds;

  // Restore persisted steps/rounds after a reload. A round that was
  // running or paused when the page died is marked interrupted so its
  // sent-but-unconfirmed requests can be reconciled against the
  // server-side history instead of being silently resent.
  useEffect(() => {
    const persisted = loadPersisted(scenario.id);
    if (!persisted) return;
    if (stepsRef.current.length === 0 && persisted.steps.length > 0) {
      setSteps(persisted.steps);
    }
    setRounds(
      persisted.rounds.map((r) =>
        r.status === "running" || r.status === "paused"
          ? { ...r, status: "interrupted" as const }
          : r
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario.id]);

  useEffect(() => {
    savePersisted(scenario.id, { steps, rounds });
  }, [scenario.id, steps, rounds]);

  const pushRounds = (next: RunRound[]) => setRounds([...next]);

  const update = (id: string, patch: Partial<SeqStep>) => {
    const idx = steps.findIndex((s) => s.id === id);
    setSteps(steps.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    // Editing a step after results exist invalidates every judgement and
    // variable from that step on; the user must confirm what gets
    // re-acquired before continuing.
    if (roundsRef.current.some((r) => Object.keys(r.results).length > 0)) {
      setStaleFrom((prev) => (prev === null ? idx : Math.min(prev, idx)));
    }
  };

  const latestRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;

  // producer step index per variable, from the newest round that produced
  // it; drives the "what must be re-acquired" preview.
  const producedByStep = useMemo(() => {
    const out: Record<string, number> = {};
    for (const round of rounds) {
      for (let i = 0; i < steps.length; i++) {
        const r = round.results[steps[i].id];
        if (r?.produced) {
          for (const k of Object.keys(r.produced)) out[k] = i;
        }
      }
    }
    return out;
  }, [rounds, steps]);

  const impact = useMemo(
    () => (staleFrom === null ? null : analyzeResume(steps, staleFrom, producedByStep)),
    [staleFrom, steps, producedByStep]
  );

  const runRound = async (fromStep: number, kind: "full" | "continuation") => {
    if (running || steps.length === 0) return;
    setRunning(true);
    setStaleFrom(null);
    const abort = new AbortController();
    abortRef.current = abort;
    const currentSteps = stepsRef.current;
    const round: RunRound = {
      id: "run-" + Date.now().toString(36) + "-" + (roundsRef.current.length + 1),
      no: roundsRef.current.length + 1,
      kind,
      startedAt: new Date().toISOString(),
      status: "running",
      fromStep,
      results: {},
    };
    if (kind === "continuation" && latestRound) {
      round.keptFromRound = latestRound.no;
    }
    const all = [...roundsRef.current, round];
    pushRounds(all);
    const push = () => pushRounds([...roundsRef.current]);
    roundsRef.current = all;

    const setRes = (stepId: string, r: StepRoundResult) => {
      round.results = { ...round.results, [stepId]: r };
      push();
    };

    try {
      let state: Record<string, unknown>;
      const producedBy = new Map<string, string>();
      if (kind === "full") {
        // A full round always starts from a clean slate so values from
        // previous rounds cannot leak into this one.
        const fresh = await api.reset(scenario.id);
        state = fresh.state ?? {};
        for (const k of Object.keys(state)) producedBy.set(k, "初始状态");
      } else {
        // A continuation keeps the independent prefix results of the
        // previous round; everything else must be re-acquired below.
        const cur = await api.get(scenario.id);
        state = cur.state ?? {};
        const prev = [...roundsRef.current]
          .reverse()
          .find((r) => r.id !== round.id && Object.keys(r.results).length > 0);
        if (prev) {
          for (let i = 0; i < fromStep && i < currentSteps.length; i++) {
            const r = prev.results[currentSteps[i].id];
            if (r?.produced) {
              for (const k of Object.keys(r.produced)) {
                producedBy.set(k, "第 " + (i + 1) + " 步（轮次 " + prev.no + " 保留）");
              }
            }
          }
        }
        for (const [k, v] of Object.entries(scenario.initialState ?? {})) {
          if (!producedBy.has(k) && k in state && JSON.stringify(state[k]) === JSON.stringify(v)) {
            producedBy.set(k, "初始状态");
          }
        }
      }

      for (let i = fromStep; i < currentSteps.length; i++) {
        const step = currentSteps[i];
        if (abort.signal.aborted) {
          markRemaining(round, currentSteps, i, "执行已取消");
          break;
        }
        // Only variables with a known source in this round are visible;
        // anything else renders empty and is reported missing.
        const visible = visibleState(state, producedBy.keys());

        const cond = evalCondition(step.conditionText, visible);
        if (!cond.run) {
          setRes(step.id, {
            status: "skipped-branch",
            branch: {
              text: step.conditionText,
              taken: false,
              rendered: cond.rendered,
              missing: cond.missing,
            },
            note: "本分支未运行，不产生任何变量；引用其产物的后续步骤会判定为变量失效",
          });
          continue;
        }
        const branch = step.conditionText.trim()
          ? { text: step.conditionText, taken: true, rendered: cond.rendered, missing: cond.missing }
          : undefined;

        const refs = findStateRefs(
          [step.path, step.query, step.headersText, step.bodyText].join("\n")
        );
        const consumed = refs.map((key) => ({ key, source: producedBy.get(key) ?? null }));
        const missing = consumed.filter((c) => c.source === null).map((c) => c.key);
        if (missing.length > 0) {
          setRes(step.id, {
            status: "invalid",
            branch,
            consumed,
            missing,
            note:
              "变量 " + missing.join("、") + " 在本轮没有来源（未运行的分支不会提供旧值）",
          });
          markRemaining(round, currentSteps, i + 1, "第 " + (i + 1) + " 步变量失效，未执行");
          break;
        }

        const sub = (t: string) => substituteState(t, visible).text;
        let headers: Record<string, string> = {};
        try {
          headers = JSON.parse(sub(step.headersText) || "{}");
        } catch {
          setRes(step.id, { status: "failed", branch, consumed, error: "请求头不是合法 JSON" });
          markRemaining(round, currentSteps, i + 1, "第 " + (i + 1) + " 步失败，未执行");
          break;
        }
        const hasBody = !["GET", "HEAD"].includes(step.method);
        const body = hasBody && sub(step.bodyText) ? sub(step.bodyText) : undefined;
        const query = sub(step.query).trim().replace(/^[?]/, "");
        const subPath = sub(step.path);
        const url =
          "/mocks/" + scenario.id + subPath + (query ? (subPath.includes("?") ? "&" : "?") + query : "");

        const reps = clampRepeat(step.repeatCount);
        const repResults: RepResult[] = [];
        const producedAll: Record<string, unknown> = {};
        let failure: StepRoundResult | null = null;
        for (let n = 1; n <= reps; n++) {
          if (abort.signal.aborted) {
            failure = { status: "cancelled", branch, consumed, repetitions: repResults, note: "执行已取消" };
            break;
          }
          const requestId = round.id + ":" + step.id + ":" + n;
          setRes(step.id, {
            status: "sent",
            branch,
            consumed,
            repetitions: [...repResults],
            requestId,
            note: "第 " + n + "/" + reps + " 次请求已发出，等待响应…",
          });
          const started = performance.now();
          try {
            const res = await fetch(url, {
              method: step.method,
              headers: {
                ...headers,
                "X-Mock-Run": round.id,
                "X-Mock-Step": step.id,
                "X-Mock-Request": requestId,
              },
              body,
              signal: abort.signal,
            });
            await res.text();
            const ms = Math.round(performance.now() - started);
            const duplicate = res.headers.get("X-Mock-Duplicate") === "1";
            const after = await api.get(scenario.id);
            const newState: Record<string, unknown> = after.state ?? {};
            const produced = diffState(state, newState);
            for (const k of Object.keys(produced)) {
              producedBy.set(k, "第 " + (i + 1) + " 步·第 " + n + " 次");
            }
            state = newState;
            Object.assign(producedAll, produced);
            repResults.push({ n, status: "ok", httpStatus: res.status, ms, requestId, produced, duplicate });
          } catch (e) {
            const cancelled = abort.signal.aborted;
            repResults.push({
              n,
              status: cancelled ? "cancelled" : "failed",
              requestId,
              error: cancelled ? "已取消" : e instanceof Error ? e.message : String(e),
            });
            failure = {
              status: cancelled ? "cancelled" : "failed",
              branch,
              consumed,
              repetitions: [...repResults],
              error: cancelled ? "已取消" : e instanceof Error ? e.message : String(e),
              note: cancelled
                ? "取消的请求不会写入场景状态"
                : "失败的请求不会写入场景状态，后续步骤不能沿用本次之前的值",
            };
            break;
          }
        }
        if (failure) {
          setRes(step.id, failure);
          markRemaining(round, currentSteps, i + 1, "第 " + (i + 1) + " 步未成功，后续未执行");
          break;
        }
        const last = repResults[repResults.length - 1];
        setRes(step.id, {
          status: "ok",
          branch,
          consumed,
          repetitions: repResults,
          produced: producedAll,
          httpStatus: last?.httpStatus,
          ms: last?.ms,
        });

        if (step.pauseAfter && i < currentSteps.length - 1) {
          round.status = "paused";
          setRes(step.id, {
            ...round.results[step.id],
            note: "已按步骤设置暂停，等待人工审阅后点“继续”",
          });
          push();
          await new Promise<void>((resolve) => {
            resumeRef.current = resolve;
          });
          resumeRef.current = null;
          round.status = "running";
          push();
          if (abort.signal.aborted) {
            markRemaining(round, currentSteps, i + 1, "执行已取消");
            break;
          }
        }
      }
      round.status = abort.signal.aborted ? "aborted" : "done";
      push();
    } catch (e) {
      round.status = "interrupted";
      push();
      setRounds((rs) => [...rs]);
      alert("执行中断：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setRunning(false);
      abortRef.current = null;
      onRefresh();
    }
  };

  const cancel = () => abortRef.current?.abort();

  // 等待结果: poll the server-side history (the saved facts) until the
  // uncertain request appears there, then attribute the late result to
  // the round it belongs to.
  const waitForResult = async (requestId: string) => {
    setWaiting((w) => ({ ...w, [requestId]: true }));
    try {
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        const sc = await api.get(scenario.id);
        if ((sc.history ?? []).some((c) => c.requestId === requestId)) {
          onRefresh();
          return;
        }
      }
    } catch {
      /* still uncertain; the user can wait again or terminate */
    } finally {
      setWaiting((w) => ({ ...w, [requestId]: false }));
    }
  };

  const terminatePath = (roundId: string, stepId: string) => {
    const next = roundsRef.current.map((round) => {
      if (round.id !== roundId) return round;
      const idx = stepsRef.current.findIndex((s) => s.id === stepId);
      const results = { ...round.results };
      results[stepId] = {
        ...results[stepId],
        status: "terminated",
        note: "结果不确定，用户选择终止该路径；未做任何重发",
      };
      for (let j = idx + 1; j < stepsRef.current.length; j++) {
        const sid = stepsRef.current[j].id;
        if (!results[sid] || results[sid].status === "sent") {
          results[sid] = { status: "skipped", note: "所在路径已终止" };
        }
      }
      return { ...round, results, status: "aborted" as const };
    });
    pushRounds(next);
  };


  // The result shown for a step comes from the newest round that has one;
  // the round badge makes clear which round each value belongs to.
  const resultFor = (stepId: string): { round: RunRound; result: StepRoundResult } | null => {
    for (let i = rounds.length - 1; i >= 0; i--) {
      const r = rounds[i].results[stepId];
      if (r) return { round: rounds[i], result: r };
    }
    return null;
  };

  const interruptedRounds = rounds.filter((r) => r.status === "interrupted");

  return (
    <div className="sequence">
      <div className="row-between">
        <h4>序列执行（条件分支 / 有限重复 / 暂停审阅；变量只取本轮产生的值）</h4>
        <div className="seq-actions">
          {!running && (
            <button
              className="btn primary"
              onClick={() => runRound(0, "full")}
              disabled={steps.length === 0 || !scenario.enabled}
            >
              执行序列（新轮次，先重置状态）
            </button>
          )}
          {running && (
            <>
              {latestRound?.status === "paused" && (
                <button className="btn primary" onClick={() => resumeRef.current?.()}>
                  继续
                </button>
              )}
              <button className="btn danger" onClick={cancel}>
                取消执行
              </button>
            </>
          )}
          <button
            className="btn-mini"
            disabled={running || steps.length === 0}
            onClick={() => {
              setSteps([]);
              setRounds([]);
              setStaleFrom(null);
            }}
          >
            清空
          </button>
        </div>
      </div>
      <p className="muted small">
        每步可配置条件（{"{{state.键}}"} 渲染为真才执行该分支）、有限重复（1-{MAX_REPEAT} 次）、
        暂停审阅。每个轮次独立记录真正运行的分支、每次重复的结果与变量来源；
        未运行的分支不会提供旧值。
      </p>

      {impact && staleFrom !== null && (
        <div className="resume-impact">
          <strong>前置条件已修改：继续前需要重新取得以下内容</strong>
          {impact.conditions.length > 0 && (
            <div>
              <span className="muted small">需要重新判断的条件：</span>
              {impact.conditions.map((c) => (
                <span key={c.stepIndex} className="var-chip">
                  第 {c.stepIndex + 1} 步：{c.text}
                </span>
              ))}
            </div>
          )}
          {impact.variables.length > 0 && (
            <div>
              <span className="muted small">涉及的变量：</span>
              {impact.variables.map((v) => (
                <span key={v.key} className={v.refetch ? "var-chip invalid" : "var-chip"}>
                  {v.key}
                  {v.refetch ? "（需重新取得）" : "（保留自 " + (v.source ?? "初始状态") + "）"}
                </span>
              ))}
            </div>
          )}
          {impact.keptSteps.length > 0 && (
            <p className="muted small">
              第 {impact.keptSteps.map((i) => i + 1).join("、")} 步的结果与本次修改无关，将作为独立结果保留；
              从第 {staleFrom + 1} 步起以新轮次继续，旧轮次其余值不会混入。
            </p>
          )}
          <div className="seq-actions">
            <button className="btn primary" onClick={() => runRound(staleFrom, "continuation")}>
              从第 {staleFrom + 1} 步继续（新轮次）
            </button>
            <button className="btn" onClick={() => runRound(0, "full")}>
              全部重新执行
            </button>
            <button className="btn-mini" onClick={() => setStaleFrom(null)}>
              暂不处理
            </button>
          </div>
        </div>
      )}

      {interruptedRounds.map((round) => (
        <div key={round.id} className="resume-impact">
          <strong>轮次 {round.no} 被中断（例如页面刷新）：按服务端已保存的事实核对</strong>
          {steps.map((step, i) => {
            const r = round.results[step.id];
            if (!r || r.status !== "sent" || i < round.fromStep) return null;
            const rec = reconcileRequest(r.requestId, scenario.history ?? []);
            return (
              <div key={step.id} className="reconcile-row">
                <span>
                  第 {i + 1} 步 {step.method} {step.path}：
                  {rec.kind === "confirmed-done" && (
                    <span className="var-chip">
                      已确认完成（HTTP {rec.record.status}）——结果归回本论次；当前轮次变量不受影响，
                      因为每轮变量独立跟踪
                    </span>
                  )}
                  {rec.kind === "confirmed-not-executed" && (
                    <span className="var-chip invalid">已确认未执行：{rec.reason}</span>
                  )}
                  {rec.kind === "uncertain" && (
                    <span className="var-chip invalid">
                      结果不确定：请求已发出但服务端暂无记录，可能迟到；不会自动重发
                    </span>
                  )}
                </span>
                {rec.kind === "uncertain" && r.requestId && (
                  <span className="seq-actions">
                    <button
                      className="btn-mini"
                      disabled={waiting[r.requestId]}
                      onClick={() => waitForResult(r.requestId!)}
                    >
                      {waiting[r.requestId] ? "等待中…" : "等待结果"}
                    </button>
                    <button className="btn-mini" onClick={() => runRound(0, "full")}>
                      重新执行独立轮次
                    </button>
                    <button className="btn-mini danger" onClick={() => terminatePath(round.id, step.id)}>
                      终止此路径
                    </button>
                  </span>
                )}
              </div>
            );
          })}
          {steps.every((s, i) => {
            const r = round.results[s.id];
            return !r || r.status !== "sent" || i < round.fromStep;
          }) && <p className="muted small">该轮次没有结果不确定的请求。</p>}
        </div>
      ))}

      {steps.length === 0 && (
        <p className="muted">
          还没有步骤。用上方“加入序列”把当前请求加入，或在调用历史里勾选一段请求重新执行。
        </p>
      )}
      {steps.map((step, i) => {
        const found = resultFor(step.id);
        const r = found?.result;
        const stale = staleFrom !== null && i >= staleFrom;
        return (
          <div key={step.id} className={"seq-step seq-" + (r?.status ?? "idle")}>
            <div className="seq-head">
              <span className="seq-num">#{i + 1}</span>
              <strong>
                {step.method} {step.path}
              </strong>
              <span className="muted small">{step.label}</span>
              {step.repeatCount > 1 && <span className="chip">×{step.repeatCount}</span>}
              {step.conditionText.trim() && <span className="chip">条件</span>}
              {step.pauseAfter && <span className="chip">暂停审阅</span>}
              {r && found && (
                <span className={"seq-badge seq-badge-" + r.status}>
                  {STATUS_TEXT[r.status]}
                  {" · 轮次 " + found.round.no}
                  {r.httpStatus !== undefined && " · HTTP " + r.httpStatus}
                  {r.ms !== undefined && " · " + r.ms + "ms"}
                </span>
              )}
              {stale && <span className="seq-badge seq-badge-invalid">待重新取得</span>}
              <button
                className="btn-mini danger"
                disabled={running}
                onClick={() => setSteps(steps.filter((s) => s.id !== step.id))}
              >
                移除
              </button>
            </div>
            <details className="seq-edit">
              <summary>查看 / 修改请求与分支</summary>
              <label className="block">
                执行条件（留空=总是执行；模板渲染为真才运行该分支，如 {"{{state.flag}}"}）
                <input
                  value={step.conditionText}
                  disabled={running}
                  onChange={(e) => update(step.id, { conditionText: e.target.value })}
                />
              </label>
              <div className="param-grid">
                <label className="inline">
                  重复次数（1-{MAX_REPEAT}）
                  <input
                    type="number"
                    min={1}
                    max={MAX_REPEAT}
                    value={step.repeatCount}
                    disabled={running}
                    onChange={(e) =>
                      update(step.id, { repeatCount: clampRepeat(Number(e.target.value)) })
                    }
                  />
                </label>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={step.pauseAfter}
                    disabled={running}
                    onChange={(e) => update(step.id, { pauseAfter: e.target.checked })}
                  />
                  本步完成后暂停，人工审阅再继续
                </label>
              </div>
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
                {r.branch && (
                  <div className="seq-vars">
                    <span className="muted small">分支判断：</span>
                    <span className={r.branch.taken ? "var-chip" : "var-chip invalid"}>
                      {r.branch.text} ⇒ {r.branch.taken ? "真（本分支已运行）" : "假（本分支未运行）"}
                      {r.branch.rendered && "（渲染为 " + r.branch.rendered + "）"}
                    </span>
                  </div>
                )}
                {r.consumed && r.consumed.length > 0 && (
                  <div className="seq-vars">
                    <span className="muted small">本次变量来源：</span>
                    {r.consumed.map((c) => (
                      <span key={c.key} className={c.source ? "var-chip" : "var-chip invalid"}>
                        {c.key} ← {c.source ?? "失效（本轮无来源）"}
                      </span>
                    ))}
                  </div>
                )}
                {r.repetitions && r.repetitions.length > 0 && (
                  <div className="seq-vars">
                    <span className="muted small">每次重复：</span>
                    {r.repetitions.map((rep) => (
                      <span
                        key={rep.n}
                        className={rep.status === "ok" ? "var-chip produced" : "var-chip invalid"}
                        title={rep.error ?? ""}
                      >
                        第 {rep.n} 次：
                        {rep.status === "ok"
                          ? "HTTP " + rep.httpStatus + " · " + rep.ms + "ms" + (rep.duplicate ? " · 幂等重放" : "")
                          : rep.status === "cancelled"
                          ? "已取消"
                          : "失败"}
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

      {rounds.length > 0 && (
        <details className="round-log">
          <summary>轮次记录（{rounds.length}）</summary>
          {rounds.map((round) => (
            <div key={round.id} className="round-row">
              <span className="chip">轮次 {round.no}</span>
              <span className="muted small">
                {round.kind === "full" ? "完整轮次（先重置）" : "续跑轮次（从第 " + (round.fromStep + 1) + " 步起）"}
                {round.keptFromRound ? "，保留轮次 " + round.keptFromRound + " 的独立结果" : ""}
                {" · "}{ROUND_STATUS_TEXT[round.status]}
                {" · "}{new Date(round.startedAt).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

