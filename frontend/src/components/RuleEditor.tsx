import type { Rule } from "../types";

function KVEditor({
  value,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  value: Record<string, string> | undefined;
  onChange: (v: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const map = value ?? {};
  const entries = Object.entries(map);
  const update = (i: number, k: string, v: string) => {
    const next: Record<string, string> = {};
    entries.forEach(([ok, ov], idx) => {
      if (idx === i) next[k] = v;
      else next[ok] = ov;
    });
    onChange(next);
  };
  return (
    <div className="kv">
      {entries.map(([k, v], i) => (
        <div className="kv-row" key={i}>
          <input
            value={k}
            placeholder={keyPlaceholder}
            onChange={(e) => update(i, e.target.value, v)}
          />
          <input
            value={v}
            placeholder={valuePlaceholder}
            onChange={(e) => update(i, k, e.target.value)}
          />
          <button
            className="btn-mini"
            onClick={() => {
              const next = Object.fromEntries(entries.filter((_, idx) => idx !== i));
              onChange(next);
            }}
          >
            删除
          </button>
        </div>
      ))}
      <button
        className="btn-mini"
        onClick={() => onChange({ ...map, "": "" })}
      >
        + 添加
      </button>
    </div>
  );
}

export function RuleEditor({
  rule,
  index,
  onChange,
  onRemove,
}: {
  rule: Rule;
  index: number;
  onChange: (r: Rule) => void;
  onRemove: () => void;
}) {
  const set = <K extends keyof Rule>(k: K, v: Rule[K]) => onChange({ ...rule, [k]: v });
  const bodyConds = rule.condition?.body ?? [];

  return (
    <div className={`rule ${rule.enabled ? "" : "rule-off"}`}>
      <div className="rule-head">
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => set("enabled", e.target.checked)}
        />
        <span className="muted">规则 #{index + 1}</span>
        <input
          className="rule-name"
          value={rule.name}
          onChange={(e) => set("name", e.target.value)}
        />
        <label className="inline">
          优先级
          <input
            type="number"
            value={rule.priority}
            onChange={(e) => set("priority", Number(e.target.value))}
          />
        </label>
        <label className="inline">
          第 N 次调用
          <input
            type="number"
            min={0}
            value={rule.nthCall}
            onChange={(e) => set("nthCall", Number(e.target.value))}
          />
        </label>
        <label className="inline">
          延迟 ms
          <input
            type="number"
            min={0}
            value={rule.delayMs}
            onChange={(e) => set("delayMs", Number(e.target.value))}
          />
        </label>
        <button className="btn-mini danger" onClick={onRemove}>
          删除规则
        </button>
      </div>

      <div className="rule-grid">
        <fieldset>
          <legend>匹配条件（全部满足才命中）</legend>
          <label className="block">
            请求头
            <KVEditor
              value={rule.condition?.headers}
              onChange={(headers) =>
                set("condition", { ...(rule.condition ?? {}), headers })
              }
              keyPlaceholder="Header 名"
              valuePlaceholder="精确值"
            />
          </label>
          <label className="block">
            Query 参数
            <KVEditor
              value={rule.condition?.queries}
              onChange={(queries) =>
                set("condition", { ...(rule.condition ?? {}), queries })
              }
              keyPlaceholder="参数名"
              valuePlaceholder="精确值"
            />
          </label>
          <div className="block">
            <div className="row-between">
              <span>Body 字段条件</span>
              <button
                className="btn-mini"
                onClick={() =>
                  set("condition", {
                    ...(rule.condition ?? {}),
                    body: [...bodyConds, { path: "", op: "eq", value: "" }],
                  })
                }
              >
                + 添加字段
              </button>
            </div>
            {bodyConds.map((c, i) => (
              <div className="kv-row" key={i}>
                <input
                  placeholder="点路径，如 user.id"
                  value={c.path}
                  onChange={(e) => {
                    const next = [...bodyConds];
                    next[i] = { ...c, path: e.target.value };
                    set("condition", { ...(rule.condition ?? {}), body: next });
                  }}
                />
                <select
                  value={c.op}
                  onChange={(e) => {
                    const next = [...bodyConds];
                    next[i] = { ...c, op: e.target.value as "eq" | "ne" | "exists" };
                    set("condition", { ...(rule.condition ?? {}), body: next });
                  }}
                >
                  <option value="eq">等于</option>
                  <option value="ne">不等于</option>
                  <option value="exists">存在</option>
                </select>
                <input
                  placeholder="比较值"
                  value={String(c.value ?? "")}
                  onChange={(e) => {
                    const next = [...bodyConds];
                    next[i] = { ...c, value: e.target.value };
                    set("condition", { ...(rule.condition ?? {}), body: next });
                  }}
                />
                <button
                  className="btn-mini"
                  onClick={() =>
                    set("condition", {
                      ...(rule.condition ?? {}),
                      body: bodyConds.filter((_, idx) => idx !== i),
                    })
                  }
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>响应 / 失败</legend>
          <label className="inline">
            失败模拟
            <select
              value={rule.fail?.kind ?? ""}
              onChange={(e) =>
                set("fail", e.target.value ? { kind: e.target.value as "reset" | "timeout" } : undefined)
              }
            >
              <option value="">正常响应</option>
              <option value="reset">连接重置</option>
              <option value="timeout">超时（挂起）</option>
            </select>
          </label>
          {!rule.fail && (
            <label className="inline">
              状态码
              <input
                type="number"
                value={rule.status}
                onChange={(e) => set("status", Number(e.target.value))}
              />
            </label>
          )}
          <label className="block">
            响应头
            <KVEditor
              value={rule.headers}
              onChange={(headers) => set("headers", headers)}
              keyPlaceholder="Header 名"
              valuePlaceholder="值，支持 {{state.x}}"
            />
          </label>
          <label className="block">
            响应体模板
            <textarea
              rows={5}
              value={rule.body}
              onChange={(e) => set("body", e.target.value)}
              spellCheck={false}
            />
          </label>
          <div className="block">
            <div className="row-between">
              <span>命中后写入场景状态</span>
              <button
                className="btn-mini"
                onClick={() => set("extract", [...(rule.extract ?? []), { from: "body", path: "", key: "" }])}
              >
                + 添加提取
              </button>
            </div>
            {(rule.extract ?? []).map((ex, i) => (
              <div className="kv-row" key={i}>
                <select
                  value={ex.from}
                  onChange={(e) => {
                    const next = [...(rule.extract ?? [])];
                    next[i] = { ...ex, from: e.target.value as typeof ex.from };
                    set("extract", next);
                  }}
                >
                  <option value="body">body</option>
                  <option value="header">header</option>
                  <option value="query">query</option>
                  <option value="path">path</option>
                </select>
                <input
                  placeholder="来源路径/键"
                  value={ex.path}
                  onChange={(e) => {
                    const next = [...(rule.extract ?? [])];
                    next[i] = { ...ex, path: e.target.value };
                    set("extract", next);
                  }}
                />
                <span className="arrow">→</span>
                <input
                  placeholder="状态键，如 orderId"
                  value={ex.key}
                  onChange={(e) => {
                    const next = [...(rule.extract ?? [])];
                    next[i] = { ...ex, key: e.target.value };
                    set("extract", next);
                  }}
                />
                <button
                  className="btn-mini"
                  onClick={() => set("extract", (rule.extract ?? []).filter((_, idx) => idx !== i))}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        </fieldset>
      </div>
    </div>
  );
}
