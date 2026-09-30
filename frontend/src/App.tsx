import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { Scenario, ValidationIssue } from "./types";
import { newScenario } from "./factory";
import { Designer } from "./components/Designer";
import { Runner } from "./components/Runner";
import { IssuesBar } from "./components/IssuesBar";

import { ChainRunner } from "./components/ChainRunner";

type Tab = "design" | "run" | "chain";

export function App() {
  const [list, setList] = useState<Scenario[]>([]);
  const [current, setCurrent] = useState<Scenario | null>(null);
  const [tab, setTab] = useState<Tab>("design");
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [loadError, setLoadError] = useState<string>("");

  const refreshList = useCallback(async () => {
    try {
      const scs = await api.list();
      setList(scs);
      setLoadError("");
      return scs;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      return [] as Scenario[];
    }
  }, []);

  const openScenario = useCallback(
    async (id: string) => {
      try {
        const sc = await api.get(id);
        setCurrent(sc);
        setIssues([]);
        setDirty(false);
      } catch (e) {
        setMessage("打开场景失败：" + (e instanceof Error ? e.message : String(e)));
        setTimeout(() => setMessage(""), 3000);
      }
    },
    []
  );

  useEffect(() => {
    refreshList().then((scs) => {
      if (scs && scs[0]) openScenario(scs[0].id);
    });
  }, [refreshList, openScenario]);

  const save = useCallback(async () => {
    if (!current) return;
    setSaving(true);
    try {
      const saved = current.id
        ? await api.update(current.id, current)
        : await api.create(current);
      setCurrent(saved);
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
      setMessage("新建场景失败：" + (e instanceof Error ? e.message : String(e)));
      setTimeout(() => setMessage(""), 3000);
    }
  }, [refreshList, openScenario]);

  const removeOne = useCallback(
    async (id: string) => {
      if (!confirm("确定删除该场景？其定义与运行数据都会被删除。")) return;
      try {
        await api.remove(id);
      } catch (e) {
        setMessage("删除失败：" + (e instanceof Error ? e.message : String(e)));
        setTimeout(() => setMessage(""), 3000);
        return;
      }
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
    const sc = await api.reset(current.id);
    setCurrent(sc);
    setMessage("当前场景已重置");
    setTimeout(() => setMessage(""), 2000);
  }, [current]);

  const refreshRuntime = useCallback(async () => {
    if (!current?.id) return;
    const sc = await api.get(current.id);
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
                <span className="muted small">{sc.endpoints.length} 端点</span>
              </button>
              <button className="btn-mini danger" onClick={() => removeOne(sc.id)}>
                删
              </button>
            </li>
          ))}
          {loadError && (
            <li className="scene-list-status">
              <p className="issue issue-error">场景列表加载失败：{loadError}</p>
              <button className="btn full" onClick={() => refreshList()}>
                重试加载
              </button>
            </li>
          )}
          {!loadError && list.length === 0 && (
            <li className="scene-list-status">
              <p className="muted small">
                还没有场景。点击上方“+ 新建场景”创建第一个场景，保存并启用后即可在“运行调试”与“链式调试”中调用。
              </p>
            </li>
          )}
        </ul>
      </aside>

      <main className="main">
        {!current && loadError && (
          <div className="empty">
            <p>场景列表加载失败：{loadError}</p>
            <button className="btn" onClick={() => refreshList()}>
              重试
            </button>
          </div>
        )}
        {!current && !loadError && (
          <div className="empty">
            <p>还没有打开的场景。</p>
            <button className="btn primary" onClick={createOne}>
              + 新建场景
            </button>
          </div>
        )}
        {current && (
          <>
            <header className="topbar">
              <div className="tabs">
                <button className={tab === "design" ? "tab active" : "tab"} onClick={() => setTab("design")}>
                  设计
                </button>
                <button className={tab === "run" ? "tab active" : "tab"} onClick={() => setTab("run")}>
                  运行调试
                </button>
                <button className={tab === "chain" ? "tab active" : "tab"} onClick={() => setTab("chain")}>
                  链式调试
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
              {tab === "chain" ? (
                <ChainRunner scenario={current} />
              ) : tab === "design" ? (
                <Designer
                  scenario={current}
                  counters={current.counters}
                  onChange={(sc) => {
                    setCurrent(sc);
                    setDirty(true);
                  }}
                />
              ) : (
                <Runner scenario={current} onReset={reset} onRefresh={refreshRuntime} />
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
