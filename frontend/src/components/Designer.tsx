import { useStore, uid } from "../store";
import type { Endpoint, Rule } from "../types";
import { EndpointEditor } from "./EndpointEditor";
import { RuleEditor } from "./RuleEditor";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function Designer() {
  const { current, updateCurrent, save, validate } = useStore();
  if (!current) return null;

  const addEndpoint = () => {
    const ep: Endpoint = {
      id: uid("ep"),
      name: "新接口",
      method: "GET",
      path: "/resource",
      enabled: true,
    };
    updateCurrent((s) => s.endpoints.push(ep));
  };

  const addRule = () => {
    const first = current.endpoints[0];
    const r: Rule = {
      id: uid("rl"),
      endpointId: first?.id ?? "",
      name: "新规则",
      enabled: false,
      priority: 10,
      conditions: [],
      delayMs: 0,
      failure: null,
      response: { status: 200, headers: {}, body: "{}" },
      operations: [],
    };
    updateCurrent((s) => s.rules.push(r));
  };

  return (
    <div className="designer">
      <section className="panel">
        <div className="panel-row">
          <label>
            场景名称
            <input
              value={current.name}
              onChange={(e) => updateCurrent((s) => (s.name = e.target.value))}
            />
          </label>
          <label className="grow">
            说明
            <input
              value={current.description ?? ""}
              onChange={(e) => updateCurrent((s) => (s.description = e.target.value))}
            />
          </label>
          <div className="actions">
            <button onClick={() => validate()}>校验</button>
            <button className="primary" onClick={() => save()}>
              保存
            </button>
          </div>
        </div>
        <details>
          <summary>初始状态变量 (initialVars)</summary>
          <InitialVarsEditor />
        </details>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>请求定义 · 接口 ({current.endpoints.length})</h3>
          <button onClick={addEndpoint}>+ 接口</button>
        </div>
        <div className="cards">
          {current.endpoints.map((ep, i) => (
            <EndpointEditor key={ep.id} index={i} endpoint={ep} />
          ))}
          {current.endpoints.length === 0 && <p className="empty-note">还没有接口定义</p>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>模拟规则 ({current.rules.length})</h3>
          <button onClick={addRule} disabled={current.endpoints.length === 0}>
            + 规则
          </button>
        </div>
        <p className="hint">
          规则按优先级从小到大匹配，首个条件全部成立的规则生效。可用字段：<code>body.x</code>、
          <code>query.x</code>、<code>headers.x</code>、<code>path.x</code>、<code>state.x</code>、
          <code>calls</code>；响应体用 <code>{"{{ ... }}"}</code> 渲染表达式。
        </p>
        <div className="cards">
          {current.rules.map((r, i) => (
            <RuleEditor key={r.id} index={i} rule={r} />
          ))}
        </div>
      </section>
    </div>
  );
}

function InitialVarsEditor() {
  const { current, updateCurrent } = useStore();
  if (!current) return null;
  const vars = current.initialVars ?? {};
  const entries = Object.entries(vars);

  const setVar = (oldKey: string, key: string, raw: string) => {
    updateCurrent((s) => {
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.initialVars ?? {})) {
        if (k === oldKey) continue;
        next[k] = v;
      }
      if (key.trim()) {
        next[key.trim()] = parseLoose(raw);
      }
      s.initialVars = next;
    });
  };

  return (
    <div className="vars-editor">
      {entries.map(([k, v]) => (
        <div className="kv-row" key={k}>
          <input defaultValue={k} onBlur={(e) => setVar(k, e.target.value, formatVal(v))} />
          <input defaultValue={formatVal(v)} onBlur={(e) => setVar(k, k, e.target.value)} />
        </div>
      ))}
      <button
        onClick={() =>
          updateCurrent((s) => {
            s.initialVars = { ...(s.initialVars ?? {}), [`var${Object.keys(s.initialVars ?? {}).length + 1}`]: 0 };
          })
        }
      >
        + 变量
      </button>
    </div>
  );
}

function parseLoose(raw: string): unknown {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  if ((t.startsWith("{") || t.startsWith("[")) && t.length) {
    try {
      return JSON.parse(t);
    } catch {
      return raw;
    }
  }
  return raw;
}

function formatVal(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export { METHODS };
