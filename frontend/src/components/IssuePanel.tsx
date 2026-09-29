import { useStore } from "../store";

export function IssuePanel() {
  const issues = useStore((s) => s.issues);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");

  return (
    <div className="issues-summary">
      <span className={errors.length ? "badge err" : "badge ok"}>{errors.length} 错误</span>
      <span className={warnings.length ? "badge warn" : "badge ok"}>{warnings.length} 警告</span>
      {errors.length > 0 && (
        <div className="issue-popover">
          {errors.concat(warnings).map((is, idx) => (
            <div key={idx} className={`issue ${is.level}`}>
              <b>{is.level === "error" ? "错误" : "警告"}</b> {is.message}
              {is.target && <code> ({is.target})</code>}
            </div>
          ))}
        </div>
      )}
      {errors.length === 0 && warnings.length > 0 && (
        <div className="issue-popover">
          {warnings.map((is, idx) => (
            <div key={idx} className="issue warning">
              <b>警告</b> {is.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
