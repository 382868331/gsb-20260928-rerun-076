import { useEffect, useMemo, useState } from "react";
import { sendMock } from "../api";
import { useStore } from "../store";
import type { MockResult } from "../api";
import { StatePanel } from "./StatePanel";

function fillPath(pattern: string): string {
  return pattern.replace(/\{([^}]+)\}/g, (_m, name: string) => encodeURIComponent(`1`));
}

export function Debugger() {
  const { current, runState, refreshState, resetState } = useStore();
  const enabledEndpoints = useMemo(() => current?.endpoints.filter((e) => e.enabled) ?? [], [current]);

  const [endpointId, setEndpointId] = useState("");
  const [method, setMethod] = useState("GET");
  const [pathInput, setPathInput] = useState("/");
  const [query, setQuery] = useState("");
  const [body, setBody] = useState("{}");
  const [headerText, setHeaderText] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<MockResult | null>(null);

  useEffect(() => {
    const first = enabledEndpoints[0];
    if (!endpointId && first) {
      setEndpointId(first.id);
      setMethod(first.method);
      setPathInput(fillPath(first.path));
      setQuery("");
    }
  }, [enabledEndpoints, endpointId]);

  if (!current) return null;

  const pickEndpoint = (id: string) => {
    setEndpointId(id);
    const ep = enabledEndpoints.find((e) => e.id === id);
    if (ep) {
      setMethod(ep.method);
      setPathInput(fillPath(ep.path));
    }
  };

  const parseHeaders = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of headerText.split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return out;
  };

  const send = async () => {
    if (!current.id) return;
    setSending(true);
    const q = query.trim() ? (query.trim().startsWith("?") ? query.trim() : `?${query.trim()}`) : "";
    const res = await sendMock(current.id, method, pathInput + q, body.trim(), parseHeaders());
    setResult(res);
    setSending(false);
    await refreshState();
  };

  const lastEntry = runState?.history[runState.history.length - 1];
  const matchedRule = result && lastEntry ? current.rules.find((r) => r.id === lastEntry.matchedRuleId) : undefined;

  return (
    <div className="debugger">
      <section className="panel">
        <div className="panel-head">
          <h3>发起真实请求</h3>
          <div className="actions">
            <button onClick={() => refreshState()}>刷新状态/历史</button>
            <button
              onClick={async () => {
                if (confirm("重置当前场景的状态、计数和历史？其他场景不受影响。")) await resetState();
              }}
            >
              重置当前场景
            </button>
          </div>
        </div>

        {enabledEndpoints.length === 0 && <div className="issue error">没有已启用的接口，请先在设计页启用。</div>}

        <div className="card-row">
          <select value={endpointId} onChange={(e) => pickEndpoint(e.target.value)}>
            {enabledEndpoints.map((ep) => (
              <option key={ep.id} value={ep.id}>
                {ep.name} — {ep.method} {ep.path}
              </option>
            ))}
          </select>
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <input className="grow mono" value={pathInput} onChange={(e) => setPathInput(e.target.value)} />
        </div>
        <div className="card-row">
          <input
            className="grow mono"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="query: kind=vip&page=2"
          />
        </div>
        <textarea className="body-input mono" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="JSON 请求体" />
        <textarea className="body-input mono small" rows={2} value={headerText} onChange={(e) => setHeaderText(e.target.value)} placeholder={"自定义请求头，每行一个: X-Token: abc"} />
        <div className="actions">
          <button className="primary" disabled={sending || enabledEndpoints.length === 0} onClick={send}>
            {sending ? "请求中…（延迟/超时按定义发生）" : "发送请求"}
          </button>
          <button onClick={send} disabled={sending} title="不清除响应，连续点击即可验证重复调用计数">
            再发一次
          </button>
        </div>
      </section>

      <section className="panel">
        <h3>响应</h3>
        {!result && <p className="empty-note">尚未发送请求</p>}
        {result && (
          <div className="result">
            <div className="result-line">
              <span className={result.ok ? "badge ok" : result.status === 0 ? "badge err" : "badge warn"}>
                {result.status === 0 ? "网络异常/断连" : `HTTP ${result.status}`}
              </span>
              <span className="muted">耗时 {result.durationMs} ms（含规则延迟）</span>
              {matchedRule && <span className="muted">命中规则: {matchedRule.name}</span>}
            </div>
            {result.networkError && <pre className="resp error-text">连接被模拟服务断开或超时: {result.networkError}</pre>}
            <pre className="resp mono">{prettyJSON(result.text)}</pre>
          </div>
        )}
      </section>

      <StatePanel />
    </div>
  );
}

function prettyJSON(text: string): string {
  if (!text) return "(空响应体)";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
