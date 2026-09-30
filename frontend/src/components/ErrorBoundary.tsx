import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

// ErrorBoundary keeps the app shell alive when one tab/view crashes, so a
// single bad request or malformed data never blanks the whole designer.
export class ErrorBoundary extends Component<{ children: ReactNode; label: string }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error(`[${this.props.label}] render error:`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fatal-panel">
          <h3>该面板遇到错误，但页面其余部分仍可操作</h3>
          <pre className="json-view">{String(this.state.error?.message ?? this.state.error)}</pre>
          <button className="btn" onClick={() => this.setState({ error: null })}>
            重试渲染
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
