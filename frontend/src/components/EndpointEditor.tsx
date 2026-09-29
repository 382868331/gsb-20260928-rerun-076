import { useStore } from "../store";
import { METHODS } from "./Designer";

export function EndpointEditor({ index, endpoint }: { index: number; endpoint: { id: string } }) {
  const { current, updateCurrent } = useStore();
  if (!current) return null;
  const ep = current.endpoints[index];

  const patch = (fn: (e: typeof ep) => void) =>
    updateCurrent((s) => fn(s.endpoints[index]));

  return (
    <div className={`card ${ep.enabled ? "" : "disabled"}`}>
      <div className="card-head">
        <label className="switch">
          <input type="checkbox" checked={ep.enabled} onChange={(e) => patch((x) => (x.enabled = e.target.checked))} />
          启用
        </label>
        <input
          className="name-input"
          value={ep.name}
          onChange={(e) => patch((x) => (x.name = e.target.value))}
        />
        <button
          className="danger-mini"
          onClick={() =>
            updateCurrent((s) => {
              s.endpoints.splice(index, 1);
              s.rules = s.rules.filter((r) => r.endpointId !== ep.id);
            })
          }
        >
          删除
        </button>
      </div>
      <div className="card-row">
        <select value={ep.method} onChange={(e) => patch((x) => (x.method = e.target.value))}>
          {METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input
          className="grow mono"
          value={ep.path}
          placeholder="/orders/{id}"
          onChange={(e) => patch((x) => (x.path = e.target.value))}
        />
      </div>
      <div className="card-foot mono muted">/m/{current.id || "{场景ID}"}{ep.path}</div>
    </div>
  );
}
