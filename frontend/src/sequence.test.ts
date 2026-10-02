import { describe, it, expect } from "vitest";
import {
  clampRepeat,
  diffState,
  evalCondition,
  emptyScope,
  findRefs,
  findStateRefs,
  MAX_REPEAT,
  planRerun,
  rebuildScope,
  resolveRef,
  substitute,
  substituteState,
} from "./sequence";

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

describe("step references", () => {
  const scope = {
    state: { token: "t-9" },
    steps: {
      2: [{ id: "A-1" }, { id: "A-2" }, { id: "A-3" }],
    },
  };

  it("resolves the selected branch / repetition results", () => {
    expect(resolveRef("state.token", scope)).toBe("t-9");
    expect(resolveRef("step.2.id", scope)).toBe("A-3"); // last repetition
    expect(resolveRef("step.2[1].id", scope)).toBe("A-1");
    expect(resolveRef("step.2[2].id", scope)).toBe("A-2");
  });

  it("a branch that did not run provides nothing", () => {
    expect(resolveRef("step.7.id", scope)).toBeUndefined();
    expect(resolveRef("step.2[9].id", scope)).toBeUndefined();
    const sub = substitute('{"a":"{{step.7.id}}"}', scope);
    expect(sub.text).toBe('{"a":""}');
    expect(sub.missing).toEqual(["step.7.id"]);
  });

  it("findRefs keeps the namespace", () => {
    expect(findRefs("{{state.a}} {{step.2[1].id}} {{step.3.token}}")).toEqual([
      "state.a",
      "step.2[1].id",
      "step.3.token",
    ]);
  });
});

describe("branch conditions", () => {
  const scope = emptyScope({ status: "ready", count: 0, token: "t" });

  it("evaluates truthy, negated and comparison forms", () => {
    expect(evalCondition("token", scope).pass).toBe(true);
    expect(evalCondition("!token", scope).pass).toBe(false);
    expect(evalCondition("count", scope).pass).toBe(false);
    expect(evalCondition("status == ready", scope).pass).toBe(true);
    expect(evalCondition("status != 'done'", scope).pass).toBe(true);
    expect(evalCondition("", scope).pass).toBe(true);
  });

  it("is undecidable when a dependency has no source", () => {
    const r = evalCondition("step.2.token", scope);
    expect(r.pass).toBeNull();
    expect(r.missing).toEqual(["step.2.token"]);
  });
});

describe("bounded repetition", () => {
  it("clamps repeat counts to a finite range", () => {
    expect(clampRepeat(undefined)).toBe(1);
    expect(clampRepeat(0)).toBe(1);
    expect(clampRepeat(3)).toBe(3);
    expect(clampRepeat(999)).toBe(MAX_REPEAT);
  });
});

describe("re-run from the middle", () => {
  const steps = [
    { id: "s1" },
    { id: "s2", repeat: 5 },
    { id: "s3", condition: "token" },
    { id: "s4" },
  ];
  const results = {
    s1: { status: "ok" },
    s2: { status: "failed", completedRepeats: 2 },
    s3: { status: "ok" },
    s4: { status: "invalid" },
  };
  const texts = {
    s3: "/x?t={{state.token}}",
    s4: '{"a":"{{step.3[1].id}}"}',
  };

  it("lists what must be re-obtained and what gets discarded", () => {
    const pf = planRerun(steps, results, new Set(), texts, 3);
    expect(pf.reAcquire).toEqual([
      { step: 3, conditions: ["token"], refs: ["state.token"] },
      { step: 4, conditions: [], refs: ["step.3[1].id"] },
    ]);
    expect(pf.discarded).toEqual([3, 4]);
    expect(pf.partialRepeats).toEqual([{ step: 2, done: 2, total: 5 }]);
    expect(pf.stalePreconditions).toEqual([]);
  });

  it("flags preconditions modified after their run", () => {
    const pf = planRerun(steps, results, new Set(["s1"]), texts, 3);
    expect(pf.stalePreconditions).toEqual([1]);
  });

  it("rebuilds the scope only from kept earlier steps", () => {
    const scope = rebuildScope(
      { base: 1 },
      ["s1", "s2", "s3"],
      { s1: [{ a: 1 }], s2: [{ b: 2 }, { b: 3 }] },
      3
    );
    expect(scope.state).toEqual({ base: 1, a: 1, b: 3 });
    expect(scope.steps[2]).toEqual([{ b: 2 }, { b: 3 }]);
    expect(scope.steps[3]).toBeUndefined();
  });
});
