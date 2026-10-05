import { describe, it, expect } from "vitest";
import { diffState, findStateRefs, substituteState } from "./sequence";

describe("sequence helpers", () => {
  it("finds unique state references", () => {
    expect(findStateRefs('{"a":"{{state.orderId}}","b":"{{ state.orderId }}"}')).toEqual([
      "orderId",
    ]);
    expect(findStateRefs("{{state.a}} {{state.b ?? 'x'}}")).toEqual(["a", "b"]);
    expect(findStateRefs("no refs")).toEqual([]);
  });

  it("substitutes known values and reports missing ones", () => {
    const r = substituteState("/orders/{{state.id}}?t={{state.token}}&x={{state.gone}}", {
      id: "A-1",
      token: "t0",
    });
    expect(r.text).toBe("/orders/A-1?t=t0&x=");
    expect(r.missing).toEqual(["gone"]);
    expect(r.refs).toEqual(["id", "token", "gone"]);
  });

  it("never falls back to stale values: unknown keys render empty", () => {
    const r = substituteState("{{state.orderId}}", {});
    expect(r.text).toBe("");
    expect(r.missing).toEqual(["orderId"]);
  });

  it("diffs state snapshots to find produced keys", () => {
    expect(diffState({ a: 1 }, { a: 1, b: 2 })).toEqual({ b: 2 });
    expect(diffState({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
    expect(diffState({ a: 1 }, { a: 1 })).toEqual({});
  });
});

import {
  evalCondition,
  reconcileRequest,
  analyzeResume,
  clampRepeat,
  visibleState,
  newSeqStep,
  MAX_REPEAT,
} from "./sequence";
import type { CallRecord } from "./types";

describe("round helpers", () => {
  it("clamps repetition to a bounded range", () => {
    expect(clampRepeat(0)).toBe(1);
    expect(clampRepeat(3)).toBe(3);
    expect(clampRepeat(999)).toBe(MAX_REPEAT);
    expect(clampRepeat(NaN)).toBe(1);
  });

  it("evaluates conditions against the visible state, failing closed on missing vars", () => {
    expect(evalCondition("", {}).run).toBe(true);
    expect(evalCondition("{{state.flag}}", { flag: "yes" }).run).toBe(true);
    expect(evalCondition("{{state.flag}}", { flag: "false" }).run).toBe(false);
    expect(evalCondition("{{state.flag}}", { flag: "0" }).run).toBe(false);
    const missing = evalCondition("{{state.gone}}", {});
    expect(missing.run).toBe(false);
    expect(missing.missing).toEqual(["gone"]);
  });

  it("restricts substitution to variables with a known source", () => {
    const visible = visibleState({ a: 1, b: 2 }, ["a"]);
    expect(visible).toEqual({ a: 1 });
  });

  it("classifies sent requests against the saved facts", () => {
    const history: CallRecord[] = [
      { seq: 1, time: "", endpointId: "e", method: "GET", path: "/a", ruleId: "", status: 200, delayMs: 0, requestId: "r-done" },
      { seq: 2, time: "", endpointId: "e", method: "GET", path: "/b", ruleId: "", status: 0, delayMs: 0, requestId: "r-cancel", cancelled: true },
      { seq: 3, time: "", endpointId: "e", method: "GET", path: "/c", ruleId: "", status: 0, delayMs: 0, requestId: "r-fail", failed: { kind: "reset" } },
    ];
    expect(reconcileRequest("r-done", history).kind).toBe("confirmed-done");
    expect(reconcileRequest("r-cancel", history).kind).toBe("confirmed-not-executed");
    expect(reconcileRequest("r-fail", history).kind).toBe("confirmed-not-executed");
    expect(reconcileRequest("r-unknown", history).kind).toBe("uncertain");
    expect(reconcileRequest(undefined, history).kind).toBe("confirmed-not-executed");
  });

  it("lists conditions and variables that must be re-acquired before resuming", () => {
    const steps = [
      newSeqStep({ id: "s1", label: "", method: "POST", path: "/a", bodyText: '{"id":1}' }),
      newSeqStep({ id: "s2", label: "", method: "GET", path: "/b/{{state.orderId}}" }),
      newSeqStep({ id: "s3", label: "", method: "GET", path: "/c", conditionText: "{{state.flag}}", query: "x={{state.orderId}}" }),
    ];
    const impact = analyzeResume(steps, 1, { orderId: 0, flag: 0 });
    expect(impact.keptSteps).toEqual([0]);
    expect(impact.conditions).toEqual([{ stepIndex: 2, text: "{{state.flag}}" }]);
    const orderId = impact.variables.find((v) => v.key === "orderId");
    // produced by step 0 (< fromIndex): kept as an independent result
    expect(orderId?.refetch).toBe(false);
    const flag = impact.variables.find((v) => v.key === "flag");
    expect(flag?.refetch).toBe(false);
    const impact2 = analyzeResume(steps, 1, { orderId: 2 });
    expect(impact2.variables.find((v) => v.key === "orderId")?.refetch).toBe(true);
  });
});

