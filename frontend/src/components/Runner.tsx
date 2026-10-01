import { useMemo, useState } from "react";
import type { CallRecord, Scenario } from "../types";
import { SequencePanel, type SeqStep } from "./SequencePanel";
import { findStateRefs, substituteState } from "../sequence";

interface Probe {
  ok: boolean;
  status: number;
  ms: number;
  headers: Record<string, string>;
  body: string;
  transportError?: string;
  sentAt: string;
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

let stepCounter = 0;

function stepFromRecord(c: CallRecord): SeqStep {
  stepCounter += 1;
  const query = Object.entries(c.reqQuery ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return {
    id: `step-${Date.now().toString(36)}-${stepCounter}`,
    label: `来自历史 #${c.seq}`,
    method: c.method,
    path: c.path,
    query,
    headersText: JSON.stringify(c.reqHeaders ?? {}, null, 2),
    bodyText: c.reqBody !== undefined && c.reqBody !== null ? JSON.stringify(c.reqBody, null, 2) : "",
  };
}

export function Runner({
  scenario,
  onReset,
  onRefresh,
}: {
  scenario: Scenario;
  onReset: () => void;
  onRefresh: () => void;
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
  const [steps, setSteps] = useState<SeqStep[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const stateNow = scenario.state ?? {};
  const refKeys = useMemo(() => {
    const all = [query, headersText, bodyText, ...Object.values(vars)].join("\n");
    return findStateRefs(all);
  }, [query, headersText, bodyText, vars]);

  const url = useMemo(() => {
    if (!ep) return "";
    return `/mocks/${scenario.id}${buildPath(ep.path, vars, query)}`;
  }, [ep, scenario.id, vars, query]);

  if (!ep) {
    return <p className="muted">场景里还没有端点，先去“设计”页添加。</p>;
  }

  const send = async () => {
    setSending(true);
    const started = performance.now();
    let reqHeaders: Record<string, string> = {};
    try {
      reqHeaders = JSON.parse(substituteState(headersText || "{}", stateNow).text);
    } catch {
      alert("请求头不是合法 JSON");
      setSending(false);
      return;
    }
    const hasBody = !['GET', 'HEAD'].includes(ep.method);
    const subVars = Object.fromEntries(
      Object.entries(vars).map(([k, v]) => [k, substituteState(v, stateNow).text])
    );
    const subQuery = substituteState(query, stateNow).text;
    const subBody = substituteState(bodyText, stateNow).text;
    const sendUrl = `/mocks/${scenario.id}${buildPath(ep.path, subVars, subQuery)}`;
    try {
      const res = await fetch(sendUrl, {
        method: ep.method,
        headers: reqHeaders,
        body: hasBody && subBody ? subBody : undefined,
      });
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => (respHeaders[k] = v));
      const text = await res.text();
      setProbe({
        ok: res.ok,
        status: res.status,
        ms: Math.round(performance.now() - started),
        headers: respHeaders,
        body: text,
        sentAt: new Date().toLocaleTimeString(),
      });
    } catch (e) {
      setProbe({
        ok: false,
        status: 0,
        ms: Math.round(performance.now() - started),
        headers: {},
        body: "",
        transportError: e instanceof Error ? e.message : String(e),
        sentAt: new Date().toLocaleTimeString(),
      });
    } finally {
      setSending(false);
      setTimeout(onRefresh, 50);
    }
  };

  const history = [...(scenario.history ?? [])].reverse();
  const toggleSelect = (seq: number) => {
    const next = new Set(selected);
    if (next.has(seq)) next.delete(seq);
    else next.add(seq);
    setSelected(next);
  };
  const addCurrentToSequence = () => {
    if (!ep) return;
    stepCounter += 1;
    setSteps([
      ...steps,
      {
        id: `step-${Date.now().toString(36)}-${stepCounter}`,
        label: ep.name,
        method: ep.method,
        path: buildPath(ep.path, vars, ""),
        query,
        headersText,
        bodyText,
      },
    ]);
  };
  const addSelectedToSequence = () => {
    const picked = (scenario.history ?? [])
      .filter((c) => selected.has(c.seq))
      .map(stepFromRecord);
    setSteps([...steps, ...picked]);
    setSelected(new Set());
  };
  const ruleName = (id: string) => {
    for (const e of scenario.endpoints) {
      const r = e.rules.find((x) => x.id === id);
      if (r) return r.name;
    }
    return "默认响应";
  };
  const epName = (id: string) => scenario.endpoints.find((e) => e.id === id);

  return (
    <div className="runner">
      <div className="runner-main">
        <div className="request-bar">
          <select value={ep.id} onChange={(e) => setEpId(e.target.value)}>
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
          <button className="btn" onClick={addCurrentToSequence} disabled={!scenario.enabled}>
            加入序列
          </button>
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
        {!['GET', 'HEAD'].includes(ep.method) && (
          <label className="block">
            请求体（原样发送，通常为 JSON）
            <textarea rows={5} value={bodyText} onChange={(e) => setBodyText(e.target.value)} spellCheck={false} />
          </label>
        )}
        {refKeys.length > 0 && (
          <p className="muted small">
            本次发送引用的状态：
            {refKeys.map((k) => (
              <span
                key={k}
                className={stateNow[k] !== undefined ? "var-chip" : "var-chip invalid"}
              >
                {k}
                {stateNow[k] !== undefined ? "" : "（当前状态不存在，将置空）"}
              </span>
            ))}
          </p>
        )}

        <SequencePanel scenario={scenario} steps={steps} setSteps={setSteps} onRefresh={onRefresh} />

        <div className="response">
          <h4>响应 {probe && <span className="muted">（{probe.sentAt}，耗时 {probe.ms}ms）</span>}</h4>
          {!probe && <p className="muted">尚未发送请求。</p>}
          {probe?.transportError && (
            <div className="resp-error">
              传输层失败（符合“连接重置/超时”等规则时会出现）：{probe.transportError}
            </div>
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

        <div className="history">
          <h4>调用历史（服务端按场景记录）</h4>
          {selected.size > 0 && (
            <button className="btn" onClick={addSelectedToSequence}>
              将选中的 {selected.size} 个请求加入序列重新执行
            </button>
          )}
          {history.length === 0 && <p className="muted">还没有调用。</p>}
          <table>
            <thead>
              <tr>
                <th></th><th>#</th><th>时间</th><th>方法</th><th>路径</th><th>命中规则</th><th>状态</th><th>延迟</th>
              </tr>
            </thead>
            <tbody>
              {history.map((c) => (
                <tr key={c.seq}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(c.seq)}
                      onChange={() => toggleSelect(c.seq)}
                    />
                  </td>
                  <td>{c.seq}</td>
                  <td>{new Date(c.time).toLocaleTimeString()}</td>
                  <td>{c.method}</td>
                  <td>{c.path}</td>
                  <td>{c.failed ? `失败：${c.failed.kind}` : c.cancelled ? "已取消" : ruleName(c.ruleId)}</td>
                  <td>{c.failed || c.cancelled ? "—" : c.status}</td>
                  <td>{c.delayMs}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
        {epName(ep.id) && history[0]?.stateAfter && (
          <>
            <h4>最近一次调用后的状态</h4>
            <pre className="json-view">{JSON.stringify(history[0].stateAfter, null, 2)}</pre>
          </>
        )}
      </aside>
    </div>
  );
}
