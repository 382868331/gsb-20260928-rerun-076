import { useEffect, useState } from "react";
import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { Designer } from "./components/Designer";
import { Debugger } from "./components/Debugger";
import { IssuePanel } from "./components/IssuePanel";

type Tab = "design" | "debug";

export function App() {
  const { loadList, current } = useStore();
  const [tab, setTab] = useState<Tab>("design");

  useEffect(() => {
    loadList().catch((e) => console.error(e));
  }, [loadList]);

  return (
    <div className="app">
      <Sidebar onNew={() => setTab("design")} />
      <main className="main">
        {!current ? (
          <div className="placeholder">
            <h2>接口设计与调试平台</h2>
            <p>从左侧新建场景，或打开已保存的场景继续编辑。</p>
            <p className="hint">
              规则支持条件分支、延迟、失败注入（HTTP 错误 / 超时 / 断连）、状态读写与重复调用计数；
              场景之间状态完全隔离。
            </p>
          </div>
        ) : (
          <>
            <nav className="tabs">
              <button className={tab === "design" ? "active" : ""} onClick={() => setTab("design")}>
                设计
              </button>
              <button
                className={tab === "debug" ? "active" : ""}
                onClick={() => setTab("debug")}
                disabled={!current.id}
                title={current.id ? "" : "先保存场景再调试"}
              >
                调试
              </button>
              <IssuePanel />
            </nav>
            {tab === "design" ? <Designer /> : <Debugger />}
          </>
        )}
      </main>
    </div>
  );
}
