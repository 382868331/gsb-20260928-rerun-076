import type { Endpoint } from "../types";
import { newRule } from "../factory";
import { RuleEditor } from "./RuleEditor";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function EndpointEditor({
  endpoint,
  callCount,
  onChange,
  onRemove,
}: {
  endpoint: Endpoint;
  callCount?: number;
  onChange: (ep: Endpoint) => void;
  onRemove: () => void;
}) {
  const set = <K extends keyof Endpoint>(k: K, v: Endpoint[K]) =>
    onChange({ ...endpoint, [k]: v });

  return (
    <section className="endpoint">
      <div className="endpoint-head">
        <select value={endpoint.method} onChange={(e) => set("method", e.target.value)}>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          className="path-input"
          value={endpoint.path}
          onChange={(e) => set("path", e.target.value)}
          placeholder="/orders/:id"
        />
        <input
          className="name-input"
          value={endpoint.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="端点名称"
        />
        {callCount !== undefined && (
          <span className="chip">已调用 {callCount} 次</span>
        )}
        <button className="btn-mini danger" onClick={onRemove}>
          删除端点
        </button>
      </div>

      <div className="default-row">
        <label className="inline">
          默认状态码
          <input
            type="number"
            value={endpoint.defaultStatus}
            onChange={(e) => set("defaultStatus", Number(e.target.value))}
          />
        </label>
        <label className="block grow">
          默认响应体（无规则命中时返回，支持模板）
          <textarea
            rows={3}
            value={endpoint.defaultBody}
            onChange={(e) => set("defaultBody", e.target.value)}
            spellCheck={false}
          />
        </label>
      </div>

      <div className="rules-head">
        <h4>规则（优先级高 + 更具体的条件优先；第 N 次调用可精确指定）</h4>
        <button className="btn" onClick={() => set("rules", [...(endpoint.rules ?? []), newRule()])}>
          + 添加规则
        </button>
      </div>
      {(endpoint.rules ?? []).map((rule, i) => (
        <RuleEditor
          key={rule.id}
          rule={rule}
          index={i}
          onChange={(r) => {
            const next = [...endpoint.rules];
            next[i] = r;
            set("rules", next);
          }}
          onRemove={() => set("rules", (endpoint.rules ?? []).filter((_, idx) => idx !== i))}
        />
      ))}
      {(endpoint.rules ?? []).length === 0 && (
        <p className="muted">还没有规则，所有请求都会走默认响应。</p>
      )}
    </section>
  );
}
