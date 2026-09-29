import { useStore } from "../store";

export function Sidebar({ onNew }: { onNew: () => void }) {
  const { list, current, loadList, open, newScenario, remove, message } = useStore();

  return (
    <aside className="sidebar">
      <div className="brand">Mock Studio</div>
      <button
        className="primary"
        onClick={async () => {
          newScenario();
          onNew();
        }}
      >
        + 新建场景
      </button>
      <div className="scene-list">
        {list.map((s) => (
          <div key={s.id} className={`scene ${current?.id === s.id ? "sel" : ""}`}>
            <div className="scene-name" onClick={() => open(s.id)} title={s.description}>
              {s.name || "未命名"}
              <span className="meta">
                {s.endpoints.filter((e) => e.enabled).length} 接口 · {s.rules.filter((r) => r.enabled).length} 规则
              </span>
            </div>
            <button
              className="danger-mini"
              onClick={async () => {
                if (confirm(`删除场景「${s.name}」及其运行状态？`)) {
                  await remove(s.id);
                  await loadList();
                }
              }}
            >
              删
            </button>
          </div>
        ))}
        {list.length === 0 && <div className="empty-note">还没有场景</div>}
      </div>
      {message && <div className="toast">{message}</div>}
    </aside>
  );
}
