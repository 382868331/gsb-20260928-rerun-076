import type { ValidationIssue } from "../types";

export function IssuesBar({
  issues,
  onJump,
}: {
  issues: ValidationIssue[];
  onJump?: (epId: string) => void;
}) {
  if (issues.length === 0) {
    return (
      <div className="issues issues-ok">校验通过，没有发现规则矛盾。</div>
    );
  }
  return (
    <div className="issues">
      {issues.map((it, i) => (
        <div key={i} className={`issue issue-${it.level}`}>
          <span className="issue-badge">{it.level === "error" ? "错误" : "警告"}</span>
          <span className="issue-msg">{it.message}</span>
          {it.endpoint && (
            <button className="link" onClick={() => onJump?.(it.endpoint!)}>
              定位
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
