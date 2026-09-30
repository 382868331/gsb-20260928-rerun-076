import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Scenario } from "../types";
import {
  invalidateFrom,
  newChainStep,
  runChain,
} from "../chain";
import type { ChainRunOutput, ChainStep } from "../chain";

function storageKey(scenarioId: string) {
  return `mockstudio.chain.${scenarioId}`;
}

function loadSteps(scenarioId: string): ChainStep[] {
  try {
    const raw = localStorage.getItem(storageKey(scenarioId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function ChainRunner({ scenario }: { scenario: Scenario }) {
  const [steps, setSteps] = useState<ChainStep[]>(() => loadSteps(scenario.id));
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [run, setRun] = useState<ChainRunOutput | null>(null);
  const [running, setRunning] = useState(false);
  const cancelRef = useRef(false);
  const runIdRef = useRef(0);

  // 切换场景时：步骤定义按场景恢复，运行结果一律丢弃（不混入旧过程）
  useEffect(() => {
    setSteps(loadSteps(scenario.id));
    setSelected({});
    setRun(null);
    setRunning(false);
    cancelRef.current = true;
  }, [scenario.id]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(scenario.id), JSON.stringify(steps));
    } catch {
      /* 存储不可用时忽略 */
    }
  }, [scenario.id, steps]);

  const epOf = useCallback(
    (id: string) => scenario.endpoints.find((e) => e.id === id),
    [scenario.endpoints]
  );

  const invalidateFromIndex = useCallback(
    (index: number) => {
      setRun((prev) => (prev ? invalidateFrom(prev, steps, index) : prev));
    },
    [steps]
  );

  const updateStep = useCallback(
    (index: number, next: ChainStep) => {
      setSteps((prev) => prev.map((s, i) => (i === index ? next : s)));
      invalidateFromIndex(index);
    },
    [invalidateFromIndex]
  );

  const removeStep = useCallback(
    (index: number) => {
      setSteps((prev) => prev.filter((_, i) => i !== index));
      invalidateFromIndex(index);
    },
    [invalidateFromIndex]
  );

  const insertStep = useCallback(
    (index: number) => {
      const st = newChainStep(scenario.endpoints[0]?.id ?? "");
      setSteps((prev) => {
        const next = [...prev];
        next.splice(index, 0, st);
        return next;
      });
      invalidateFromIndex(index);
    },
    [invalidateFromIndex, scenario.endpoints]
  );

  const selectedRange = useMemo(() => {
    const idxs = steps
      .map((s, i) => (selected[s.id] ? i : -1))
      .filter((i) => i >= 0);
    if (idxs.length === 0) return null;
    return { from: Math.min(...idxs), to: Math.max(...idxs) };
  }, [steps, selected]);

  const execute = useCallback(
    async (from: number, to: number) => {
      if (running) return;
      runIdRef.current += 1;
      const runId = runIdRef.current;
      cancelRef.current = false;
      setRunning(true);
      setRun(null);
      try {
        const out = await runChain({
          steps,
          endpoints: scenario.endpoints,
          scenarioId: scenario.id,
          from,
          to,
          runId,
          fetchFn: fetch,
          isCancelled: () => cancelRef.current,
          onProgress: (partial) =>
            setRun({
              ...partial,
              results: { ...partial.results },
              variables: { ...partial.variables },
              invalidations: [...partial.invalidations],
            }),
        });
        setRun({
          ...out,
          results: { ...out.results },
          variables: { ...out.variables },
          invalidations: [...out.invalidations],
        });
      } finally {
        setRunning(false);
      }
    },
    [running, steps, scenario.endpoints, scenario.id]
  );

  const varEntries = Object.values(run?.variables ?? {});
  const invalidations = run?.invalidations ?? [];

  return (
    <div className="chain">
      <div className="chain-head">
        <div>
          <h3>链式调试</h3>
          <p className="muted small">
            按顺序执行一串有依赖的请求：用 {'{{'}变量名{'}}'} 在后续步骤中引用前序步骤提取的值。
            每次执行都从空变量表开始；失败、取消或修改前置步骤后，后续结果与变量立即失效，不会沿用上次成功的值。
          </p>
        </div>
        <div className="chain-actions">
          <button
            className="btn primary"
            disabled={running || steps.length === 0 || !scenario.enabled}
            onClick={() => execute(0, steps.length - 1)}
          >
            执行全部
          </button>
          <button
            className="btn"
            disabled={running || !selectedRange || !scenario.enabled}
            onClick={() =>
              selectedRange && execute(selectedRange.from, selectedRange.to)
            }
          >
            执行选中区间
            {selectedRange &&
              `（第 ${selectedRange.from + 1}–${selectedRange.to + 1} 步）`}
          </button>
          {running && (
            <button
              className="btn danger"
              onClick={() => {
                cancelRef.current = true;
              }}
            >
              取消
            </button>
          )}
          {!running && run && (
            <button className="btn" onClick={() => setRun(null)}>
              清空结果
            </button>
          )}
        </div>
      </div>

      {!scenario.enabled && (
        <div className="issue issue-error">场景未启用，请先在上方保存并通过校验后启用。</div>
      )}
      {scenario.endpoints.length === 0 && (
        <div className="issue issue-warning">场景里还没有端点，请先在“设计”页添加端点。</div>
      )}

      <div className="chain-body">
        <div className="chain-steps">
          {steps.length === 0 && (
            <p className="muted">还没有步骤。点击下方“+ 添加步骤”组建请求链。</p>
          )}
          {steps.map((step, i) => {
            const ep = epOf(step.endpointId);
            const result = run?.results[step.id];
            const pathVarNames = ep
              ? [...ep.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1])
              : [];
            return (
              <div key={step.id} className={`chain-step ${result ? (result.ok ? "ok" : result.executed ? "fail" : "skip") : ""}`}>
                <div className="step-head">
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={!!selected[step.id]}
                      onChange={(e) =>
                        setSelected({ ...selected, [step.id]: e.target.checked })
                      }
                    />
                    第 {i + 1} 步
                  </label>
                  <select
                    value={step.endpointId}
                    onChange={(e) =>
                      updateStep(i, { ...step, endpointId: e.target.value, pathVars: {} })
                    }
                  >
                    {!ep && <option value={step.endpointId}>（端点已失效，请重新选择）</option>}
                    {scenario.endpoints.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.method} {e.path} — {e.name}
                      </option>
                    ))}
                  </select>
                  <span className="grow" />
                  <button className="btn-mini" onClick={() => insertStep(i + 1)}>
                    下方插入
                  </button>
                  <button className="btn-mini danger" onClick={() => removeStep(i)}>
                    删除
                  </button>
                </div>

                {ep && (
                  <div className="step-fields">
                    {pathVarNames.map((name) => (
                      <label className="inline" key={name}>
                        :{name}
                        <input
                          value={step.pathVars[name] ?? ""}
                          placeholder={"值或 {{变量}}"}
                          onChange={(e) =>
                            updateStep(i, {
                              ...step,
                              pathVars: { ...step.pathVars, [name]: e.target.value },
                            })
                          }
                        />
                      </label>
                    ))}
                    <label className="inline grow">
                      Query
                      <input
                        value={step.query}
                        placeholder="a=1&b={{变量}}"
                        onChange={(e) => updateStep(i, { ...step, query: e.target.value })}
                      />
                    </label>
                    <label className="block">
                      请求头 JSON
                      <textarea
                        rows={1}
                        value={step.headersText}
                        spellCheck={false}
                        onChange={(e) => updateStep(i, { ...step, headersText: e.target.value })}
                      />
                    </label>
                    {!["GET", "HEAD"].includes(ep.method) && (
                      <label className="block">
                        请求体
                        <textarea
                          rows={3}
                          value={step.bodyText}
                          placeholder={'如 {"orderId":"{{orderId}}"}'}
                          spellCheck={false}
                          onChange={(e) => updateStep(i, { ...step, bodyText: e.target.value })}
                        />
                      </label>
                    )}
                    <div className="extracts">
                      <span className="muted small">提取响应到变量：</span>
                      {step.extracts.map((ex, j) => (
                        <div className="extract-row" key={j}>
                          <input
                            placeholder="响应路径，如 data.id"
                            value={ex.path}
                            onChange={(e) =>
                              updateStep(i, {
                                ...step,
                                extracts: step.extracts.map((x, k) =>
                                  k === j ? { ...x, path: e.target.value } : x
                                ),
                              })
                            }
                          />
                          <span>→</span>
                          <input
                            placeholder="变量名"
                            value={ex.key}
                            onChange={(e) =>
                              updateStep(i, {
                                ...step,
                                extracts: step.extracts.map((x, k) =>
                                  k === j ? { ...x, key: e.target.value } : x
                                ),
                              })
                            }
                          />
                          <button
                            className="btn-mini danger"
                            onClick={() =>
                              updateStep(i, {
                                ...step,
                                extracts: step.extracts.filter((_, k) => k !== j),
                              })
                            }
                          >
                            删
                          </button>
                        </div>
                      ))}
                      <button
                        className="btn-mini"
                        onClick={() =>
                          updateStep(i, {
                            ...step,
                            extracts: [...step.extracts, { path: "", key: "" }],
                          })
                        }
                      >
                        + 添加提取
                      </button>
                    </div>
                  </div>
                )}

                {result && (
                  <div className="step-result">
                    {result.skipped && <span className="chip skip">{result.skipped}</span>}
                    {result.executed && (
                      <>
                        <span className={`status-badge status-${Math.floor((result.status || 0) / 100)}`}>
                          {result.status || "—"}
                        </span>
                        <span className="muted small">{result.ms}ms</span>
                        {result.error && <span className="chip fail">{result.error}</span>}
                      </>
                    )}
                    {result.usedVars.length > 0 && (
                      <span className="var-chips">
                        使用：
                        {result.usedVars.map((u) => (
                          <span className="chip" key={u.key} title={`来自第 ${u.fromStep + 1} 步`}>
                            {u.key} ← 第{u.fromStep + 1}步
                          </span>
                        ))}
                      </span>
                    )}
                    {result.produced.length > 0 && (
                      <span className="var-chips">
                        产生：
                        {result.produced.map((k) => (
                          <span className="chip ok" key={k}>{k}</span>
                        ))}
                      </span>
                    )}
                    {result.body && (
                      <pre className="json-view">{pretty(result.body)}</pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <button className="btn full" onClick={() => insertStep(steps.length)}>
            + 添加步骤
          </button>
        </div>

        <aside className="chain-side">
          <h4>本次执行变量{run && <span className="muted small">（运行 #{run.runId}）</span>}</h4>
          {!run && <p className="muted small">尚未执行。每次执行从空变量表开始。</p>}
          {run && varEntries.length === 0 && (
            <p className="muted small">本次执行没有产生变量。</p>
          )}
          {varEntries.length > 0 && (
            <table>
              <thead>
                <tr><th>变量</th><th>值</th><th>来源</th></tr>
              </thead>
              <tbody>
                {varEntries.map((v) => (
                  <tr key={v.key}>
                    <td><code>{v.key}</code></td>
                    <td><code>{JSON.stringify(v.value)}</code></td>
                    <td>第 {v.fromStep + 1} 步</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {invalidations.length > 0 && (
            <>
              <h4>失效位置</h4>
              <ul className="invalid-list">
                {invalidations.map((iv, i) => (
                  <li key={i}>
                    <code>{iv.key}</code> —— 第 {iv.atStep + 1} 步：{iv.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
          {run?.cancelled && <p className="chip fail">本次执行已取消，未完成的步骤不会沿用旧值。</p>}
          {run && run.halted && !run.cancelled && (
            <p className="chip fail">执行在中途失败，后续步骤已跳过且变量已失效。</p>
          )}
        </aside>
      </div>
    </div>
  );
}
