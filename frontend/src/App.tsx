import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { Scenario, ValidationIssue } from "./types";
import { ensureCollections, newScenario, scenarioFingerprint } from "./factory";
import { Designer } from "./components/Designer";
import { Runner } from "./components/Runner";
import { IssuesBar } from "./components/IssuesBar";
import { ErrorBoundary } from "./components/ErrorBoundary";

type Tab = "design" | "run";

// Save outcomes the user must be able to tell apart:
// - saving: request in flight
// - saved: server confirmed the save
// - failed: server answered with an error — the save definitely did not
//   happen; the current input and selection are kept
// - unconfirmed: the request was sent but no response arrived — the save
//   may or may not have landed; the user can ask for a re-check instead
//   of refreshing and guessing
type SaveStatus = "idle" | "saving" | "saved" | "failed" | "unconfirmed";

export function App() {
  const [list, setList] = useState<Scenario[]>([]);
  const [current, setCurrent] = useState<Scenario | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>("design");
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveDetail, setSaveDetail] = useState("");
  const [message, setMessage] = useState<string>("");
  const saving = saveStatus === "saving";

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
        setSaveStatus("idle");
        setSaveDetail("");
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

  // save returns the saved scenario on success, null otherwise. On failure
  // the current input, dirty flag and scenario selection are all preserved
  // so the user can retry without retyping anything.
  const save = useCallback(async (): Promise<Scenario | null> => {
    if (!current) return null;
    setSaveStatus("saving");
    setSaveDetail("");
    try {
      const saved = current.id
        ? await api.update(current.id, current)
        : await api.create(current);
      const normalized = ensureCollections(saved);
      setCurrent(normalized);
      setDirty(false);
      setSaveStatus("saved");
      setSaveDetail(new Date().toLocaleTimeString());
      // A broken list refresh or validation must not turn a confirmed save
      // into a failure — the save itself already succeeded.
      try {
        await refreshList();
      } catch {
        /* list will refresh on next action */
      }
      try {
        const res = await api.validate(saved.id, saved);
        setIssues(res.issues ?? []);
      } catch {
        /* validation panel keeps previous issues */
      }
      return normalized;
    } catch (e) {
      const err = e as Error & { status?: number };
      if (typeof err.status === "number") {
        // The server answered: the save was rejected for real.
        setSaveStatus("failed");
        setSaveDetail(err.message);
      } else {
        // No answer at all: the request may have landed. Do not guess.
        setSaveStatus("unconfirmed");
        setSaveDetail("保存请求已发出，但没有收到服务器响应，结果未确认。");
      }
      return null;
    }
  }, [current, refreshList]);

  // reconfirm compares the server-side content with the local input to
  // decide whether an unconfirmed save actually landed.
  const reconfirmSave = useCallback(async () => {
    if (!current) return;
    setSaveDetail("正在向服务器核对…");
    const want = scenarioFingerprint(current);
    try {
      if (current.id) {
        const server = ensureCollections(await api.get(current.id));
        if (scenarioFingerprint(server) === want) {
          setCurrent(server);
          setDirty(false);
          setSaveStatus("saved");
          setSaveDetail(new Date().toLocaleTimeString());
        } else {
          setSaveStatus("failed");
          setSaveDetail("服务器上的内容与本次输入不一致，保存未生效，请重试。");
        }
      } else {
        const scs = (await api.list()).map(ensureCollections);
        const match = scs.find((sc) => scenarioFingerprint(sc) === want);
        if (match) {
          const full = ensureCollections(await api.get(match.id));
          setCurrent(full);
          setDirty(false);
          setSaveStatus("saved");
          setSaveDetail(new Date().toLocaleTimeString());
          await refreshList();
        } else {
          setSaveStatus("failed");
          setSaveDetail("服务器上未找到本次内容，保存未生效，请重试。");
        }
      }
    } catch {
      setSaveStatus("unconfirmed");
      setSaveDetail("仍无法连接服务器，保存结果未确认。");
    }
  }, [current, refreshList]);

  const validateNow = useCallback(async () => {
    if (!current) return;
    const target = current.id ? current : await save();
    if (!target?.id) return;
    const res = await api.validate(target.id, target);
    setIssues(res.issues ?? []);
  }, [current, save]);

  const enable = useCallback(async () => {
    if (!current) return;
    const saved = await save();
    if (!saved) return; // save failure is already surfaced; keep the input
    try {
      const res = await api.enable(saved.id);
      setIssues(res.issues ?? []);
      await openScenario(saved.id);
      await refreshList();
      setMessage("场景已启用");
    } catch (e) {
      const err = e as Error & { data?: { issues?: ValidationIssue[] } };
      if (err.data?.issues) setIssues(err.data.issues);
      setMessage("启用被阻止：请先解决错误");
    } finally {
      setTimeout(() => setMessage(""), 3000);
    }
  }, [current, save, openScenario, refreshList]);

  // New scenarios start as local drafts: they only reach the server when
  // the user saves, so a failed/uncertain save never strands a half-made
  // server-side record and the current input stays put.
  const createOne = useCallback(async () => {
    setCurrent(newScenario());
    setIssues([]);
    setDirty(true);
    setSaveStatus("idle");
    setSaveDetail("");
    setTab("design");
  }, []);

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
          {current && !current.id && (
            <li className="active">
              <button className="scene-item">
                <span className="scene-name">{current.name || "新场景"}（未保存的草稿）</span>
              </button>
            </li>
          )}
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
                {saveStatus === "saving" && <span className="save-pill save-saving">正在保存…</span>}
                {saveStatus === "saved" && (
                  <span className="save-pill save-ok">已保存{saveDetail ? ` · ${saveDetail}` : ""}</span>
                )}
                {saveStatus === "failed" && (
                  <span className="save-pill save-fail" title={saveDetail}>
                    保存失败：{saveDetail}（本次输入已保留）
                  </span>
                )}
                {saveStatus === "unconfirmed" && (
                  <span className="save-pill save-unknown" title={saveDetail}>
                    保存结果未确认
                    <button className="btn-mini" onClick={reconfirmSave}>
                      重新确认
                    </button>
                  </span>
                )}
                {dirty && saveStatus !== "saving" && (
                  <span className="muted small">有未保存修改</span>
                )}
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
              <ErrorBoundary>
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
              </ErrorBoundary>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
