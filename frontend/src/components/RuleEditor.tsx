import { useStore } from "../store";
import type { Condition, Failure, Operation, Rule } from "../types";

const OPS = [
  ["eq", "等于 =="],
  ["ne", "不等于 !="],
  ["gt", "大于 >"],
  ["gte", ">="],
  ["lt", "小于 <"],
  ["lte", "<="],
  ["exists", "存在"],
  ["contains", "包含"],
  ["in", "属于数组"],
] as const;

export function RuleEditor({ index, rule }: { index: number; rule: Rule }) {
  const { current, updateCurrent, issues } = useStore();
  if (!current) return null;
  const r = current.rules[index];
  const patch = (fn: (x: Rule) => void) => updateCurrent((s) => fn(s.rules[index]));
  const ruleIssues = issues.filter((i) => i.target === r.id);

  return (
    <div className={`card wide ${r.enabled ? "" : "disabled"}`}>
      <div className="card-head">
        <label className="switch">
          <input type="checkbox" checked={r.enabled} onChange={(e) => patch((x) => (x.enabled = e.target.checked))} />
          启用
        </label>
        <input className="name-input" value={r.name} onChange={(e) => patch((x) => (x.name = e.target.value))} />
        <label className="priority">
          优先级
          <input
            type="number"
            value={r.priority}
            onChange={(e) => patch((x) => (x.priority = Number(e.target.value)))}
          />
        </label>
        <select value={r.endpointId} onChange={(e) => patch((x) => (x.endpointId = e.target.value))}>
          {current.endpoints.map((ep) => (
            <option key={ep.id} value={ep.id}>
              {ep.method} {ep.path}
            </option>
          ))}
        </select>
        <button className="danger-mini" onClick={() => updateCurrent((s) => s.rules.splice(index, 1))}>
          删除
        </button>
      </div>

      {ruleIssues.length > 0 && (
        <div className="rule-issues">
          {ruleIssues.map((is, i) => (
            <div key={i} className={`issue ${is.level}`}>
              {is.message}
            </div>
          ))}
        </div>
      )}

      <div className="section-title">条件（全部满足才命中；留空表示无条件）</div>
      {r.conditions.map((c, ci) => (
        <ConditionRow key={ci} cond={c} onChange={(fn) => patch((x) => fn(x.conditions[ci]))} onRemove={() => patch((x) => x.conditions.splice(ci, 1))} />
      ))}
      <button className="mini" onClick={() => patch((x) => x.conditions.push({ field: "body.", op: "eq", value: "" }))}>
        + 条件
      </button>

      <div className="grid2">
        <label>
          延迟 (ms)
          <input type="number" value={r.delayMs} onChange={(e) => patch((x) => (x.delayMs = Number(e.target.value)))} />
        </label>
        <FailureEditor failure={r.failure ?? null} onChange={(f) => patch((x) => (x.failure = f))} />
      </div>

      <div className="section-title">响应（未勾选失败分支时使用）</div>
      <div className="card-row">
        <label>
          状态码
          <input
            type="number"
            value={r.response.status}
            onChange={(e) => patch((x) => (x.response.status = Number(e.target.value)))}
          />
        </label>
      </div>
      <textarea
        className="body-input mono"
        rows={5}
        value={r.response.body}
        onChange={(e) => patch((x) => (x.response.body = e.target.value))}
      />

      <div className="section-title">命中后写入状态（响应渲染前执行，可被本次响应引用）</div>
      {r.operations.map((op, oi) => (
        <OperationRow key={oi} op={op} onChange={(fn) => patch((x) => fn(x.operations[oi]))} onRemove={() => patch((x) => x.operations.splice(oi, 1))} />
      ))}
      <button className="mini" onClick={() => patch((x) => x.operations.push({ target: "state.", op: "set", value: "body." }))}>
        + 状态操作
      </button>
    </div>
  );
}

function ConditionRow({
  cond,
  onChange,
  onRemove,
}: {
  cond: Condition;
  onChange: (fn: (c: Condition) => void) => void;
  onRemove: () => void;
}) {
  return (
    <div className="cond-row">
      <input className="mono grow" value={cond.field} onChange={(e) => onChange((c) => (c.field = e.target.value))} placeholder="body.amount" />
      <select value={cond.op} onChange={(e) => onChange((c) => (c.op = e.target.value))}>
        {OPS.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      {cond.op !== "exists" && (
        <input
          className="mono grow"
          value={typeof cond.value === "string" ? cond.value : JSON.stringify(cond.value)}
          onChange={(e) => onChange((c) => (c.value = parseValue(e.target.value)))}
          placeholder='比较值，如 100、"vip"、[1,2]'
        />
      )}
      <button className="danger-mini" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

function OperationRow({
  op,
  onChange,
  onRemove,
}: {
  op: Operation;
  onChange: (fn: (o: Operation) => void) => void;
  onRemove: () => void;
}) {
  return (
    <div className="cond-row">
      <input className="mono grow" value={op.target} onChange={(e) => onChange((o) => (o.target = e.target.value))} placeholder="state.orderId" />
      <select value={op.op} onChange={(e) => onChange((o) => (o.op = e.target.value as Operation["op"]))}>
        <option value="set">set =</option>
        <option value="increment">increment +=</option>
        <option value="unset">unset</option>
      </select>
      {op.op !== "unset" && (
        <input className="mono grow" value={op.value ?? ""} onChange={(e) => onChange((o) => (o.value = e.target.value))} placeholder="表达式，如 body.id 或 state.n + 1" />
      )}
      <button className="danger-mini" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

function FailureEditor({ failure, onChange }: { failure: Failure | null; onChange: (f: Failure | null) => void }) {
  return (
    <div className="failure-box">
      <label className="switch">
        <input type="checkbox" checked={!!failure} onChange={(e) => onChange(e.target.checked ? { type: "http_error", status: 500, message: "" } : null)} />
        失败分支
      </label>
      {failure && (
        <>
          <select value={failure.type} onChange={(e) => onChange({ ...failure, type: e.target.value as Failure["type"] })}>
            <option value="http_error">HTTP 错误</option>
            <option value="timeout">超时挂起</option>
            <option value="disconnect">直接断连</option>
          </select>
          {failure.type === "http_error" && (
            <>
              <input type="number" value={failure.status ?? 500} onChange={(e) => onChange({ ...failure, status: Number(e.target.value) })} />
              <input value={failure.message ?? ""} onChange={(e) => onChange({ ...failure, message: e.target.value })} placeholder="错误消息" />
            </>
          )}
          {failure.type === "timeout" && (
            <label>
              挂起 ms
              <input type="number" value={failure.timeoutMs ?? 5000} onChange={(e) => onChange({ ...failure, timeoutMs: Number(e.target.value) })} />
            </label>
          )}
        </>
      )}
    </div>
  );
}

function parseValue(raw: string): unknown {
  const t = raw.trim();
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch {
      return raw;
    }
  }
  if (!Number.isNaN(Number(t))) return Number(t);
  return raw;
}
