import { useStore } from "../store";

export function StatePanel() {
  const { current, runState } = useStore();
  if (!current || !runState) return null;

  const endpointName = (id: string) => current.endpoints.find((e) => e.id === id)?.path ?? id;
  const ruleName = (id?: string) => current.rules.find((r) => r.id === id)?.name ?? "(无匹配规则/默认响应)";
  const history = [...runState.history].reverse();

  return (
    <div className="state-grid">
      <section className="panel">
        <h3>当前场景状态（隔离）</h3>
        <pre className="mono state-box">{JSON.stringify(runState.vars, null, 2)}</pre>
        <h4>调用计数</h4>
        {Object.keys(runState.counters).length === 0 && <div className="empty-note">尚无调用</div>}
        {Object.entries(runState.counters).map(([id, n]) => (
          <div key={id} className="counter-row">
            <span className="mono">{endpointName(id)}</span>
            <span className="badge ok">{n} 次</span>
          </div>
        ))}
      </section>

      <section className="panel">
        <h3>请求历史（最近在最上）</h3>
        {history.length === 0 && <div className="empty-note">尚无请求</div>}
        {history.map((h) => (
          <details key={h.seq} className="history-item">
            <summary>
              <span className={h.status >= 200 && h.status < 300 ? "badge ok" : h.status === 0 ? "badge err" : "badge warn"}>
                {h.status === 0 ? h.failure : h.status}
              </span>
              <span className="mono">{h.method} {h.path}</span>
              <span className="muted">{ruleName(h.matchedRuleId)} · {h.elapsedMs}ms</span>
            </summary>
            {h.reqBody && (
              <>
                <div className="muted">请求体</div>
                <pre className="mono small-pre">{h.reqBody}</pre>
              </>
            )}
            <div className="muted">响应体</div>
            <pre className="mono small-pre">{h.respBody || "(连接被断开，无响应)"}</pre>
          </details>
        ))}
      </section>
    </div>
  );
}
