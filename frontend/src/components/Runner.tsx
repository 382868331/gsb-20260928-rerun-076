import { useMemo, useRef, useState } from "react";
import type {
  CallRecord,
  InteractionSequence,
  Scenario,
  SequenceStep,
} from "../types";
import { expandTemplate } from "../template";

interface Probe {
  ok: boolean;
  status: number;
  ms: number;
  headers: Record<string, string>;
  body: string;
  transportError?: string;
  canceled?: boolean;
  sentAt: string;
  endpointId?: string;
  matchedHistorySeq?: number;
  historyMismatch?: string;
}

function buildPath(tpl: string, vars: Record<string, string>, query: string): string {
  let path = tpl.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) =>
    encodeURIComponent(vars[name] ?? `:${name}`)
  );
  if (query.trim()) {
    path += (path.includes("?") ? "&" : "?") + query.trim().replace(/^[?]/, "");
  }
  return path;
}

function extractVars(tpl: string): string[] {
  const out: string[] = [];
  const re = /:([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tpl))) out.push(m[1]);
  return out;
}

function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

interface StepResult {
  step: number;
  name: string;
  status: number;
  ok: boolean;
  transportError?: string;
  canceled?: boolean;
  ms: number;
  body: string;
  historySeq?: number;
  historyMismatch?: string;
}

let seqCounter = 0;
function clientId(prefix: string): string {
  seqCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${seqCounter}`;
}

export function Runner({
  scenario,
  onReset,
  onRefresh,
  onSaveSequence,
  onDeleteSequence,
}: {
  scenario: Scenario;
  onReset: () => Promise<void> | void;
  onRefresh: () => Promise<void> | void;
  onSaveSequence: (seq: InteractionSequence) => Promise<void>;
  onDeleteSequence: (seqId: string) => Promise<void>;
}) {
  const [epId, setEpId] = useState(scenario.endpoints[0]?.id ?? "");
  const ep = scenario.endpoints.find((e) => e.id === epId) ?? scenario.endpoints[0];
  const pathVars = extractVars(ep?.path ?? "");
  const [vars, setVars] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [headersText, setHeadersText] = useState('{"Content-Type":"application/json"}');
  const [bodyText, setBodyText] = useState("");
  const [probe, setProbe] = useState<Probe | null>(null);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<SequenceStep[]>([]);
  const [seqName, setSeqName] = useState("");
  const [replaying, setReplaying] = useState(false);
  const [replayResults, setReplayResults] = useState<StepResult[]>([]);
  const [replayReset, setReplayReset] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  // Reset local scratch whenever the selected endpoint disappears (e.g. the
  // defining rule was deleted) so stale vars never bleed into a new selection.
  const activeEp = ep ?? scenario.endpoints[0];

  const cancel = () => {
    abortRef.current?.abort();
  };

  const issueRequest = async (
    target: { id: string; method: string; path: string },
    opts: {
      vars: Record<string, string>;
      query: string;
      headersText: string;
      bodyText: string;
      state: Record<string, unknown>;
      record?: SequenceStep;
    }
  ): Promise<{ probe: Probe; step?: SequenceStep }> => {
    const reqHeaders: Record<string, string> = {};
    try {
      Object.assign(reqHeaders, JSON.parse(opts.headersText || "{}"));
    } catch {
      throw new Error("请求头不是合法 JSON");
    }
    const renderedBody = opts.bodyText
      ? expandTemplate(opts.bodyText, opts.state)
      : "";
    const url = `/mocks/${scenario.id}${buildPath(
      target.path,
      Object.fromEntries(
        Object.entries(opts.vars).map(([k, v]) => [k, expandTemplate(v, opts.state)])
      ),
      opts.query
    )}`;
    const started = performance.now();
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const hasBody = !["GET", "HEAD"].includes(target.method);
      const res = await fetch(url, {
        method: target.method,
        headers: reqHeaders,
        body: hasBody && renderedBody ? renderedBody : undefined,
        signal: ctl.signal,
      });
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => (respHeaders[k] = v));
      const text = await res.text();
      return {
        probe: {
          ok: res.ok,
          status: res.status,
          ms: Math.round(performance.now() - started),
          headers: respHeaders,
          body: text,
          sentAt: new Date().toLocaleTimeString(),
          endpointId: target.id,
        },
        step: opts.record,
      };
    } catch (e) {
      const aborted = ctl.signal.aborted;
      return {
        probe: {
          ok: false,
          status: 0,
          ms: Math.round(performance.now() - started),
          headers: {},
          body: "",
          transportError: e instanceof Error ? e.message : String(e),
          canceled: aborted,
          sentAt: new Date().toLocaleTimeString(),
          endpointId: target.id,
        },
        step: opts.record,
      };
    } finally {
      if (abortRef.current === ctl) abortRef.current = null;
    }
  };

  const url = useMemo(() => {
    if (!activeEp) return "";
    return `/mocks/${scenario.id}${buildPath(activeEp.path, vars, query)}`;
  }, [activeEp, scenario.id, vars, query]);

  if (!activeEp) {
    return (
      <div className="runner">
        <p className="muted">场景里还没有端点，先去“设计”页添加。</p>
        <div className="history">
          <HistoryView
            history={scenario.history ?? []}
            endpoints={scenario.endpoints}
          />
        </div>
      </div>
    );
  }

  // Compare the just-finished client-side result with the server-side history
  // record; failures must stay attributed to this request instead of crashing
  // the page. Returns the refreshed history slice for the matching seq.
  const checkHistoryConsistency = (
    beforeLen: number,
    p: Probe,
    refreshedHistory: CallRecord[] | undefined
  ): Probe => {
    if (!refreshedHistory) return p;
    // The server records every processed call, including reset/timeout rules.
    const rec = refreshedHistory.find(
      (c) => c.endpointId === p.endpointId && c.seq > beforeLen
    );
    if (!rec) {
      if (p.canceled) {
        return { ...p, historyMismatch: "已取消：服务端可能未处理完成，历史中没有本次记录（符合预期）。" };
      }
      if (p.transportError) {
        // simulated reset/timeout: a record is normally still appended
        return {
          ...p,
          historyMismatch: "传输失败，但服务端历史缺少对应记录，请检查规则或服务状态。",
        };
      }
      return p;
    }
    const mismatches: string[] = [];
    if (!p.transportError && rec.status !== p.status) {
      mismatches.push(`状态码实际 ${p.status} 与历史 ${rec.status} 不一致`);
    }
    if (p.transportError && !rec.failed) {
      mismatches.push("客户端传输失败，但历史记录为正常响应");
    }
    if (!p.transportError && rec.failed) {
      mismatches.push(`历史记录为失败 ${rec.failed.kind}，但客户端收到正常响应`);
    }
    return {
      ...p,
      matchedHistorySeq: rec.seq,
      historyMismatch: mismatches.length ? mismatches.join("；") : undefined,
    };
  };

  const send = async () => {
    if (!activeEp) return;
    setSending(true);
    setProbe(null);
    const beforeLen = scenario.history?.length ?? 0;
    const step: SequenceStep = {
      endpointId: activeEp.id,
      method: activeEp.method,
      path: activeEp.path,
      vars: { ...vars },
      query,
      headers: headersText,
      body: bodyText,
    };
    let result: Probe;
    try {
      const r = await issueRequest(
        { id: activeEp.id, method: activeEp.method, path: activeEp.path },
        {
          vars,
          query,
          headersText,
          bodyText,
          state: (scenario.state ?? {}) as Record<string, unknown>,
          record: step,
        }
      );
      result = r.probe;
    } catch (e) {
      result = {
        ok: false,
        status: 0,
        ms: 0,
        headers: {},
        body: "",
        transportError: e instanceof Error ? e.message : String(e),
        sentAt: new Date().toLocaleTimeString(),
        endpointId: activeEp.id,
      };
    }
    // Pull the authoritative runtime snapshot before declaring consistency.
    const fresh = await fetch(`/api/scenarios/${scenario.id}`).then((r) => r.json()) as Scenario;
    result = checkHistoryConsistency(beforeLen, result, fresh.history);
    setProbe(result);
    setSending(false);
    await onRefresh();
    if (recording) {
      setRecorded((prev) => [...prev, step]);
    }
  };

  const saveCurrentSequence = async () => {
    if (recorded.length === 0) return;
    const name = seqName.trim() || `交互序列 ${new Date().toLocaleTimeString()}`;
    await onSaveSequence({
      id: clientId("seq"),
      name,
      createdAt: "",
      steps: recorded,
    });
    setSeqName("");
    setRecorded([]);
    setRecording(false);
  };

  const replay = async (seq: InteractionSequence) => {
    setReplaying(true);
    setReplayResults([]);
    try {
      if (replayReset) await onReset();
      let live: Scenario = await fetch(`/api/scenarios/${scenario.id}`).then((r) => r.json());
      const out: StepResult[] = [];
      for (let i = 0; i < seq.steps.length; i++) {
        const st = seq.steps[i];
        const target = scenario.endpoints.find((e) => e.id === st.endpointId);
        const beforeLen = live.history?.length ?? 0;
        if (!target) {
          out.push({
            step: i + 1,
            name: `${st.method} ${st.path}（端点已删除）`,
            status: 0,
            ok: false,
            transportError: "端点在当前定义中不存在，已跳过该步骤（错误保留在本步骤）",
            ms: 0,
            body: "",
          });
          continue;
        }
        const r = await issueRequest(
          { id: target.id, method: target.method, path: target.path },
          {
            vars: st.vars ?? {},
            query: st.query ?? "",
            headersText: st.headers ?? "{}",
            bodyText: st.body ?? "",
            state: (live.state ?? {}) as Record<string, unknown>,
          }
        );
        await new Promise((res) => setTimeout(res, 60));
        live = await fetch(`/api/scenarios/${scenario.id}`).then((r2) => r2.json());
        const checked = checkHistoryConsistency(beforeLen, r.probe, live.history);
        out.push({
          step: i + 1,
          name: `${target.method} ${target.path}`,
          status: checked.status,
          ok: checked.ok,
          transportError: checked.transportError,
          canceled: checked.canceled,
          ms: checked.ms,
          body: checked.body,
          historySeq: checked.matchedHistorySeq,
          historyMismatch: checked.historyMismatch,
        });
        setReplayResults([...out]);
        if (r.probe.canceled) break;
      }
      await onRefresh();
    } finally {
      setReplaying(false);
    }
  };

  const history = [...(scenario.history ?? [])].reverse();

  return (
    <div className="runner">
      <div className="runner-main">
        <div className="request-bar">
          <select value={activeEp.id} onChange={(e) => { setEpId(e.target.value); setProbe(null); }}>
            {scenario.endpoints.map((e) => (
              <option key={e.id} value={e.id}>
                {e.method} {e.path} — {e.name}
              </option>
            ))}
          </select>
          <code className="url-preview">{url}</code>
          <button className="btn primary" onClick={send} disabled={sending || !scenario.enabled}>
            {sending ? "等待响应…" : "发送请求"}
          </button>
          {sending && (
            <button className="btn danger" onClick={cancel}>
              取消请求
            </button>
          )}
          <label className="inline small">
            <input type="checkbox" checked={recording} onChange={(e) => setRecording(e.target.checked)} />
            录制本次交互
          </label>
        </div>
        {!scenario.enabled && (
          <div className="issue issue-error">场景未启用，请先在上方保存并通过校验后启用。</div>
        )}

        {pathVars.length > 0 && (
          <div className="param-grid">
            {pathVars.map((name) => (
              <label className="inline" key={name}>
                :{name}
                <input
                  value={vars[name] ?? ""}
                  onChange={(e) => setVars({ ...vars, [name]: e.target.value })}
                />
              </label>
            ))}
            <label className="inline grow">
              Query（如 a=1&b=2）
              <input value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
          </div>
        )}
        {pathVars.length === 0 && (
          <label className="block">
            Query（如 a=1&b=2）
            <input value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}

        <label className="block">
          请求头 JSON
          <textarea rows={2} value={headersText} onChange={(e) => setHeadersText(e.target.value)} spellCheck={false} />
        </label>
        {!['GET', 'HEAD'].includes(activeEp.method) && (
          <label className="block">
            请求体（原样发送，通常为 JSON；支持 {'{'}{'{'}state.x{'}'}{'}'} 模板，实时按当前场景状态展开）
            <textarea rows={5} value={bodyText} onChange={(e) => setBodyText(e.target.value)} spellCheck={false} />
          </label>
        )}

        <div className="response">
          <h4>响应 {probe && <span className="muted">（{probe.sentAt}，耗时 {probe.ms}ms）</span>}</h4>
          {!probe && <p className="muted">尚未发送请求。</p>}
          {probe?.transportError && (
            <div className="resp-error">
              {probe.canceled ? "请求已取消：" : "传输层失败（符合“连接重置/超时”等规则时会出现）："}
              {probe.transportError}
            </div>
          )}
          {probe?.historyMismatch && (
            <div className={probe.canceled ? "issue issue-warning" : "issue issue-error"}>
              历史一致性：{probe.historyMismatch}
            </div>
          )}
          {probe && !probe.transportError && !probe.historyMismatch && probe.matchedHistorySeq !== undefined && (
            <p className="muted small">已与服务端历史第 {probe.matchedHistorySeq} 条记录核对一致。</p>
          )}
          {probe && !probe.transportError && (
            <>
              <span className={`status-badge status-${Math.floor(probe.status / 100)}`}>
                {probe.status}
              </span>
              <pre className="json-view">{pretty(probe.body) || "(空响应体)"}</pre>
            </>
          )}
        </div>

        <HistoryView history={scenario.history ?? []} endpoints={scenario.endpoints} />
      </div>

      <aside className="runner-side">
        <div className="side-head">
          <h4>当前场景状态</h4>
          <div>
            <button className="btn-mini" onClick={onReset}>重置当前场景</button>
            <button className="btn-mini" onClick={onRefresh}>刷新</button>
          </div>
        </div>
        <p className="muted small">
          重置仅清空本场景的状态、计数与历史，不影响其它场景，也不改动定义。
        </p>
        <pre className="json-view">{JSON.stringify(scenario.state ?? {}, null, 2)}</pre>
        <h4>端点调用计数</h4>
        <pre className="json-view">
          {JSON.stringify(
            Object.fromEntries(
              scenario.endpoints.map((e) => [e.name, scenario.counters?.[e.id] ?? 0])
            ),
            null,
            2
          )}
        </pre>
        {history[0]?.stateAfter && (
          <>
            <h4>最近一次调用后的状态</h4>
            <pre className="json-view">{JSON.stringify(history[0].stateAfter, null, 2)}</pre>
          </>
        )}

        <div className="sequences-panel">
          <div className="side-head">
            <h4>交互序列</h4>
          </div>
          {recording && (
            <div className="recording">
              <p className="muted small">录制中：已记录 {recorded.length} 步</p>
              <ol className="step-list">
                {recorded.map((s, i) => (
                  <li key={i}>{i + 1}. {s.method} {s.path}</li>
                ))}
              </ol>
              <input
                placeholder="序列名称"
                value={seqName}
                onChange={(e) => setSeqName(e.target.value)}
              />
              <div className="row-between">
                <button className="btn-mini primary" onClick={saveCurrentSequence} disabled={recorded.length === 0}>
                  保存序列
                </button>
                <button className="btn-mini" onClick={() => { setRecording(false); setRecorded([]); }}>
                  放弃录制
                </button>
              </div>
            </div>
          )}

          <label className="inline small">
            <input
              type="checkbox"
              checked={replayReset}
              onChange={(e) => setReplayReset(e.target.checked)}
            />
            重放前重新开始场景（重置状态/计数/历史）
          </label>

          {(scenario.sequences ?? []).length === 0 && (
            <p className="muted small">还没有保存的序列。勾选“录制本次交互”后发送若干请求即可保存。</p>
          )}
          {(scenario.sequences ?? []).map((seq) => (
            <div className="seq-item" key={seq.id}>
              <div className="row-between">
                <strong>{seq.name}</strong>
                <span className="muted small">{seq.steps.length} 步</span>
              </div>
              <div>
                <button className="btn-mini primary" onClick={() => replay(seq)} disabled={replaying || !scenario.enabled}>
                  {replaying ? "重放中…" : "重放"}
                </button>
                <button
                  className="btn-mini danger"
                  onClick={() => onDeleteSequence(seq.id)}
                  disabled={replaying}
                >
                  删除
                </button>
              </div>
            </div>
          ))}

          {replayResults.length > 0 && (
            <div className="replay-results">
              <h4>重放结果（错误保留在对应步骤）</h4>
              {replayResults.map((r2) => (
                <div key={r2.step} className={`replay-step ${r2.ok ? "ok" : "bad"}`}>
                  <div>
                    {r2.step}. {r2.name} — {r2.canceled ? "已取消" : r2.transportError ? `传输失败：${r2.transportError}` : `${r2.status} · ${r2.ms}ms`}
                  </div>
                  {r2.historyMismatch && <div className="issue issue-error">{r2.historyMismatch}</div>}
                  {!r2.transportError && r2.body && (
                    <details>
                      <summary>响应体</summary>
                      <pre className="json-view small">{pretty(r2.body)}</pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function HistoryView({
  history,
  endpoints,
}: {
  history: CallRecord[];
  endpoints: Scenario["endpoints"];
}) {
  const ordered = [...history].reverse();
  const ruleName = (epId: string, ruleId: string) => {
    const e = endpoints.find((x) => x.id === epId);
    const r = e?.rules.find((x) => x.id === ruleId);
    return r ? r.name : "默认响应";
  };
  return (
    <div className="history">
      <h4>调用历史（服务端按场景记录）</h4>
      {ordered.length === 0 && <p className="muted">还没有调用。</p>}
      {ordered.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>#</th><th>时间</th><th>方法</th><th>路径</th><th>命中规则</th><th>状态</th><th>延迟</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((c) => (
              <tr key={c.seq} className={c.failed ? "row-failed" : ""}>
                <td>{c.seq}</td>
                <td>{new Date(c.time).toLocaleTimeString()}</td>
                <td>{c.method}</td>
                <td>{c.path}</td>
                <td>{c.failed ? `失败：${c.failed.kind}` : ruleName(c.endpointId, c.ruleId)}</td>
                <td>{c.failed ? "—" : c.status}</td>
                <td>{c.delayMs}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
