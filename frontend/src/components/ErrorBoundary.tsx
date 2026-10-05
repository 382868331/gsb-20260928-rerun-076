import { Component, type ReactNode } from "react";

// ErrorBoundary keeps a render exception (e.g. an unexpected null
// collection) from blanking the whole page: the user keeps the sidebar
// and can retry instead of losing the debugging session.
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="empty">
          <p>页面渲染出错（已拦截，未整页崩溃）：{this.state.error.message}</p>
          <button className="btn primary" onClick={() => this.setState({ error: null })}>
            重试渲染
          </button>
          <button className="btn" onClick={() => location.reload()}>
            重新加载页面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

