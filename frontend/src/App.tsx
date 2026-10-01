import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { Scenario, ValidationIssue } from "./types";
import { ensureCollections, newScenario } from "./factory";
import { Designer } from "./components/Designer";
import { Runner } from "./components/Runner";
import { IssuesBar } from "./components/IssuesBar";

type Tab = "design" | "run";

export function App() {
  const [list, setList] = useState<Scenario[]>([]);
  const [current, setCurrent] = useState<Scenario | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>("design");
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>("");

  const refreshList = useCallback(async () => {
    const scs = (await api.list()).map(ensureCollections);
    setList(scs);
    return scs;
  }, []);

  const openScenario = useCallback(
    async (id: string) => {
      try {
        const sc = ensureCollections(await api.get(id));
        setCurrent(sc);
        setIssues([]);
        setDirty(false);
      } catch (e) {
        setMessage(`打开场景失败：${e instanceof Error ? e.message : String(e)}`);
        setTimeout(() => setMessage(""), 3000);
      }
    },
    []
  );

  const load = useCallback(async () => {
    setLoadState("loading");
    setLoadError("");
    try {
      const scs = await refreshList();
      setLoadState("ready");
      if (scs[0]) await openScenario(scs[0].id);
      else setCurrent(null);
    } catch (e) {
      setLoadState("error");
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [refreshList, openScenario]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async () => {
    if (!current) return;
    setSaving(true);
    try {
      const saved = current.id
        ? await api.update(current.id, current)
        : await api.create(current);
      setCurrent(ensureCollections(saved));
      setDirty(false);
      await refreshList();
      const res = await api.validate(saved.id, saved);
      setIssues(res.issues);
      setMessage("已保存");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(""), 2500);
    }
  }, [current, refreshList]);

  const validateNow = useCallback(async () => {
    if (!current) return;
    if (!current.id) await save();
    if (!current?.id) return;
    const res = await api.validate(current.id, current);
    setIssues(res.issues);
  }, [current, save]);

  const enable = useCallback(async () => {
    if (!current) return;
    setSaving(true);
    try {
      await save();
      const id = current.id;
      const res = await api.enable(id);
      setIssues(res.issues);
      await openScenario(id);
      await refreshList();
      setMessage("场景已启用");
    } catch (e) {
      const err = e as Error & { data?: { issues?: ValidationIssue[] } };
      if (err.data?.issues) setIssues(err.data.issues);
      setMessage("启用被阻止：请先解决错误");
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(""), 3000);
    }
  }, [current, save, openScenario, refreshList]);

  const createOne = useCallback(async () => {
    try {
      const sc = await api.create(newScenario());
      await refreshList();
      await openScenario(sc.id);
      setTab("design");
    } catch (e) {
      setMessage(`新建场景失败：${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => setMessage(""), 3000);
    }
  }, [refreshList, openScenario]);

  const removeOne = useCallback(
    async (id: string) => {
      if (!confirm("确定删除该场景？其定义与运行数据都会被删除。")) return;
      await api.remove(id);
      const scs = await refreshList();
      if (current?.id === id) {
        if (scs[0]) await openScenario(scs[0].id);
        else setCurrent(null);
      }
    },
    [refreshList, openScenario, current]
  );

  const reset = useCallback(async () => {
    if (!current) return;
    const sc = ensureCollections(await api.reset(current.id));
    setCurrent(sc);
    setMessage("当前场景已重置");
    setTimeout(() => setMessage(""), 2000);
  }, [current]);

  const refreshRuntime = useCallback(async () => {
    if (!current?.id) return;
    const sc = ensureCollections(await api.get(current.id));
    setCurrent((prev) =>
      prev
        ? {
            ...prev,
            state: sc.state,
            counters: sc.counters,
            history: sc.history,
            enabled: sc.enabled,
          }
        : sc
    );
  }, [current?.id]);

  const errors = useMemo(() => issues.filter((i) => i.level === "error"), [issues]);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Mock Studio</h1>
        <button className="btn primary full" onClick={createOne}>
          + 新建场景
        </button>
        <ul className="scene-list">
          {list.map((sc) => (
            <li key={sc.id} className={current?.id === sc.id ? "active" : ""}>
              <button className="scene-item" onClick={() => openScenario(sc.id)}>
                <span className="scene-name">{sc.name}</span>
                <span className={`dot ${sc.enabled ? "on" : "off"}`} title={sc.enabled ? "已启用" : "未启用"} />
                <span className="muted small">{(sc.endpoints ?? []).length} 端点</span>
              </button>
              <button className="btn-mini danger" onClick={() => removeOne(sc.id)}>
                删
              </button>
            </li>
          ))}
          {loadState === "ready" && list.length === 0 && (
            <p className="muted small">还没有场景，点击上方按钮新建。</p>
          )}
          {loadState === "loading" && <p className="muted small">加载中…</p>}
          {loadState === "error" && <p className="muted small">列表加载失败。</p>}
        </ul>
      </aside>

      <main className="main">
        {loadState === "loading" && <div className="empty">正在加载场景列表…</div>}
        {loadState === "error" && (
          <div className="empty">
            <p>场景列表加载失败：{loadError}</p>
            <button className="btn primary" onClick={load}>
              重试
            </button>
          </div>
        )}
        {loadState === "ready" && !current && (
          <div className="empty">
            <p>还没有任何场景。</p>
            <button className="btn primary" onClick={createOne}>
              + 新建第一个场景
            </button>
          </div>
        )}
        {loadState === "ready" && current && (
          <>
            <header className="topbar">
              <div className="tabs">
                <button className={tab === "design" ? "tab active" : "tab"} onClick={() => setTab("design")}>
                  设计
                </button>
                <button className={tab === "run" ? "tab active" : "tab"} onClick={() => setTab("run")}>
                  运行调试
                </button>
              </div>
              <div className="top-actions">
                <span className={`status-pill ${current.enabled ? "on" : "off"}`}>
                  {current.enabled ? "已启用" : "未启用"}
                </span>
                {dirty && <span className="muted small">有未保存修改</span>}
                {message && <span className="toast">{message}</span>}
                <button className="btn" onClick={validateNow} disabled={saving}>
                  校验规则
                </button>
                <button className="btn" onClick={save} disabled={saving}>
                  保存
                </button>
                <button className="btn primary" onClick={enable} disabled={saving}>
                  保存并启用
                </button>
              </div>
            </header>

            {errors.length > 0 && tab === "design" && (
              <div className="banner-error">
                存在 {errors.length} 个阻断性错误，启用前必须修复（见下方校验面板）。
              </div>
            )}

            {tab === "design" && (
              <IssuesBar
                issues={issues}
                onJump={() => {
                  const first = current.endpoints.find((e) =>
                    issues.some((i) => i.endpoint === e.id)
                  );
                  if (first) document.querySelector(`[data-ep="${first.id}"]`)?.scrollIntoView();
                }}
              />
            )}

            <div className="content" data-ep={current.endpoints[0]?.id}>
              {tab === "design" ? (
                <Designer
                  scenario={current}
                  counters={current.counters}
                  onChange={(sc) => {
                    setCurrent(sc);
                    setDirty(true);
                  }}
                />
              ) : (
                <Runner
                  key={`${current.id}@${current.updatedAt}`}
                  scenario={current}
                  onReset={reset}
                  onRefresh={refreshRuntime}
                />
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
