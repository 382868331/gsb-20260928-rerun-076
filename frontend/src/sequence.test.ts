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
