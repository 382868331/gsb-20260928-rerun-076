import { useState } from "react";
import type { Scenario } from "../types";
import { newEndpoint } from "../factory";
import { EndpointEditor } from "./EndpointEditor";

export function Designer({
  scenario,
  counters,
  onChange,
}: {
  scenario: Scenario;
  counters?: Record<string, number>;
  onChange: (sc: Scenario) => void;
}) {
  const [openEp, setOpenEp] = useState<string | null>(scenario.endpoints[0]?.id ?? null);
  const set = <K extends keyof Scenario>(k: K, v: Scenario[K]) =>
    onChange({ ...scenario, [k]: v });

  const stateText = JSON.stringify(scenario.initialState, null, 2);

  return (
    <div className="designer">
      <div className="scenario-meta">
        <label className="inline">
          场景名称
          <input value={scenario.name} onChange={(e) => set("name", e.target.value)} />
        </label>
        <label className="inline grow">
          描述
          <input
            value={scenario.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </label>
      </div>

      <div className="state-editor">
        <label className="block">
          初始状态（每次“重置场景”恢复为这份 JSON；规则可用 {'{'}{'{'} state.键 {'}'}{'}'} 引用，可用提取写入）
          <textarea
            rows={4}
            defaultValue={stateText}
            spellCheck={false}
            onBlur={(e) => {
              try {
                const parsed = JSON.parse(e.target.value || "{}");
                set("initialState", parsed);
              } catch {
                alert("初始状态不是合法 JSON");
              }
            }}
          />
        </label>
      </div>

      <div className="rules-head">
        <h3>端点定义</h3>
        <button
          className="btn"
          onClick={() => {
            const ep = newEndpoint();
            set("endpoints", [...scenario.endpoints, ep]);
            setOpenEp(ep.id);
          }}
        >
          + 添加端点
        </button>
      </div>

      {scenario.endpoints.map((ep) => (
        <div key={ep.id} className="endpoint-wrap">
          <button className="endpoint-collapse" onClick={() => setOpenEp(openEp === ep.id ? null : ep.id)}>
            <strong>
              {ep.method} {ep.path}
            </strong>
            <span className="muted">{ep.name} · {ep.rules.filter(r => r.enabled).length} 条启用规则</span>
          </button>
          {openEp === ep.id && (
            <EndpointEditor
              endpoint={ep}
              callCount={counters?.[ep.id]}
              onChange={(next) =>
                set(
                  "endpoints",
                  scenario.endpoints.map((e) => (e.id === ep.id ? next : e))
                )
              }
              onRemove={() =>
                set("endpoints", scenario.endpoints.filter((e) => e.id !== ep.id))
              }
            />
          )}
        </div>
      ))}
    </div>
  );
}
