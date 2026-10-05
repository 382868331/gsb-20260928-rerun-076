import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { Scenario, ValidationIssue } from "./types";
import { ensureCollections, localId, newScenario } from "./factory";
import { Designer } from "./components/Designer";
import { Runner } from "./components/Runner";
import { IssuesBar } from "./components/IssuesBar";

type Tab = "design" | "run";
type SaveStatus = "idle" | "saving" | "saved" | "unknown" | "error";

interface DraftState {
  scenario: Scenario;
  status: SaveStatus;
  error?: string;
  originalId?: string;
  updatedAt: number;
}

const DRAFT_KEY = "mock-studio.drafts.v1";

function readDrafts(): Record<string, DraftState> {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}"); } catch { return {}; }
}

function writeDrafts(drafts: Record<string, DraftState>) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
}

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
  const [drafts, setDrafts] = useState<Record<string, DraftState>>(() => readDrafts());
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const recoveredRef = useRef(false);

  const activeDraft = draftKey ? drafts[draftKey] : undefined;

  const updateDraft = useCallback((key: string, next: DraftState | null) => {
    setDrafts((prev) => {
      const out = { ...prev };
      if (next) out[key] = next;
      else delete out[key];
      writeDrafts(out);
      return out;
    });
  }, []);

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
        setDraftKey(sc.clientId ?? null);
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

  useEffect(() => {
    if (loadState !== "ready" || recoveredRef.current) return;
    recoveredRef.current = true;
    const unknown = Object.entries(drafts).find(([, d]) => d.status === "saving" || d.status === "unknown");
    if (!unknown) return;
    const [key, draft] = unknown;
    const confirmed = list.find((sc) => sc.clientId === draft.scenario.clientId);
    if (confirmed) {
      openScenario(confirmed.id).then(() => updateDraft(key, null));
      setMessage("检测到上次保存结果未知，已在服务端确认保存成功");
    } else {
      setCurrent(ensureCollections(draft.scenario));
      setDraftKey(key);
      setDirty(true);
      setTab("design");
      setMessage("上次保存结果未知：已恢复输入，可重新核查后再保存");
    }
  }, [loadState, drafts, list, openScenario, updateDraft]);

  const save = useCallback(async (): Promise<Scenario | null> => {
    if (!current) return null;
    const key = current.clientId || localId("draft");
    const originalId = current.id || drafts[draftKey ?? ""]?.originalId;
    const nextDraft = { scenario: current, status: "saving" as const, originalId: current.id || originalId, updatedAt: Date.now() };
    setDraftKey(key);
    updateDraft(key, nextDraft);
    setSaving(true);
    try {
      const withClient = { ...current, clientId: current.clientId || key };
      const saved = current.id
        ? await api.update(current.id, withClient, current.contentHash)
        : await api.create(withClient);
      setCurrent(ensureCollections(saved));
      setDirty(false);
      updateDraft(key, null);
      await refreshList();
      const res = await api.validate(saved.id, saved);
      setIssues(res.issues);
      setMessage("已保存");
      return saved;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = (e as { status?: number })?.status;
      updateDraft(key, {
        scenario: { ...current, clientId: current.clientId || key },
        status: status ? "error" : "unknown",
        error: msg,
        originalId: current.id || nextDraft.originalId,
        updatedAt: Date.now(),
      });
      setMessage(`保存结果未知或已失败，输入已保留：${msg}`);
      return null;
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(""), 2500);
    }
  }, [current, refreshList, updateDraft, draftKey, drafts]);

  const validateNow = useCallback(async () => {
    if (!current) return;
    const saved = !current.id ? await save() : current;
    if (!saved?.id) return;
    const res = await api.validate(saved.id, saved);
    setIssues(res.issues);
  }, [current, save]);

  const enable = useCallback(async () => {
    if (!current) return;
    try {
      const saved = await save();
      if (!saved) return;
      const id = saved.id;
      setSaving(true);
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
    const sc = ensureCollections(newScenario());
    const key = sc.clientId ?? localId("draft");
    setCurrent({ ...sc, clientId: key });
    setDraftKey(key);
    setIssues([]);
    setDirty(true);
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
            operations: sc.operations,
            activeRoundId: sc.activeRoundId,
            enabled: sc.enabled,
            contentHash: sc.contentHash,
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
                <button className="btn" onClick={save} disabled={saving} title={activeDraft?.status === "unknown" ? "结果尚未确认" : ""}>
                  {saving ? "正在保存…" : activeDraft?.status === "unknown" ? "结果未知，重新核查" : "保存"}
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

            {activeDraft && activeDraft.status !== "saved" && tab === "design" && (
              <div className={`banner-save banner-${activeDraft.status}`}>
                {activeDraft.status === "saving" && "正在保存，请勿依赖刷新猜测结果。"}
                {activeDraft.status === "unknown" && "保存结果尚未确认；输入和原场景选择已保留，可重新保存核查，不会自动重发。"}
                {activeDraft.status === "error" && `已确认保存失败：${activeDraft.error ?? "未知错误"}；输入仍保留。`}
                {activeDraft.status === "unknown" && (
                  <button className="btn-mini" onClick={save}>重新核查并保存</button>
                )}
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
