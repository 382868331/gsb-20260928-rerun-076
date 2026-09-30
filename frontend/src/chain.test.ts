import { describe, it, expect } from "vitest";
import {
  getPath,
  invalidateFrom,
  newChainStep,
  runChain,
  substitute,
  type ChainStep,
  type FetchLike,
} from "./chain";
import type { Endpoint } from "./types";

const endpoints: Endpoint[] = [
  {
    id: "ep-create",
    name: "创建订单",
    method: "POST",
    path: "/orders",
    defaultStatus: 201,
    defaultBody: "",
    rules: [],
  },
  {
    id: "ep-get",
    name: "查询订单",
    method: "GET",
    path: "/orders/:id",
    defaultStatus: 200,
    defaultBody: "",
    rules: [],
  },
];

function step(partial: Partial<ChainStep>): ChainStep {
  return { ...newChainStep(), ...partial };
}

const ok =
  (body: string, status = 200): FetchLike =>
  async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });

describe("substitute", () => {
  it("replaces known vars and reports missing ones", () => {
    const vars = { orderId: { key: "orderId", value: "A1", fromStep: 0, runId: 1 } };
    const r = substitute('{"id":"{{orderId}}","x":"{{ missing }}"}', vars);
    expect(r.out).toBe('{"id":"A1","x":"{{ missing }}"}');
    expect(r.missing).toEqual(["missing"]);
  });
});

describe("getPath", () => {
  it("walks dot paths and arrays", () => {
    const obj = { data: { list: [{ id: 7 }] } };
    expect(getPath(obj, "data.list.0.id")).toBe(7);
    expect(getPath(obj, "data.nope")).toBeUndefined();
  });
});

const steps = () => [
    step({
      id: "s1",
      endpointId: "ep-create",
      bodyText: '{"name":"x"}',
      extracts: [{ path: "id", key: "orderId" }],
    }),
    step({
      id: "s2",
      endpointId: "ep-get",
      pathVars: { id: "{{orderId}}" },
    }),
  ];

describe("runChain", () => {
  it("passes extracted values to later steps", async () => {
    const seen: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      seen.push(url);
      return { ok: true, status: 200, text: async () => '{"id":"O-9"}' };
    };
    const out = await runChain({
      steps: steps(),
      endpoints,
      scenarioId: "sc1",
      from: 0,
      to: 1,
      runId: 1,
      fetchFn,
    });
    expect(out.halted).toBe(false);
    expect(out.variables.orderId).toMatchObject({ value: "O-9", fromStep: 0 });
    expect(seen[1]).toBe("/mocks/sc1/orders/O-9");
    expect(out.results.s2.usedVars).toEqual([{ key: "orderId", fromStep: 0 }]);
  });

  it("stops on failure and marks later variables invalid", async () => {
    const out = await runChain({
      steps: steps(),
      endpoints,
      scenarioId: "sc1",
      from: 0,
      to: 1,
      runId: 1,
      fetchFn: ok('{"error":"boom"}', 500),
    });
    expect(out.halted).toBe(true);
    expect(out.results.s1.ok).toBe(false);
    expect(out.results.s2.executed).toBe(false);
    expect(out.variables.orderId).toBeUndefined();
    expect(out.invalidations).toEqual([
      { key: "orderId", atStep: 1, reason: "第 1 步失败，变量未产生" },
    ]);
  });

  it("does not reuse values from a previous successful run", async () => {
    const first = await runChain({
      steps: steps(),
      endpoints,
      scenarioId: "sc1",
      from: 0,
      to: 1,
      runId: 1,
      fetchFn: ok('{"id":"O-9"}'),
    });
    expect(first.variables.orderId?.value).toBe("O-9");
    const second = await runChain({
      steps: steps(),
      endpoints,
      scenarioId: "sc1",
      from: 0,
      to: 1,
      runId: 2,
      fetchFn: ok('{"error":"boom"}', 500),
    });
    expect(second.variables.orderId).toBeUndefined();
    expect(second.results.s2.skipped).toContain("未执行");
  });

  it("treats a re-run range as a fresh process without earlier values", async () => {
    const out = await runChain({
      steps: steps(),
      endpoints,
      scenarioId: "sc1",
      from: 1,
      to: 1,
      runId: 3,
      fetchFn: ok("{}"),
    });
    expect(out.results.s1.skipped).toContain("不在本次执行区间");
    expect(out.results.s2.error).toContain("缺少变量");
    expect(out.invalidations.some((iv) => iv.key === "orderId" && iv.atStep === 1)).toBe(true);
  });

  it("stops remaining steps when cancelled", async () => {
    let calls = 0;
    const out = await runChain({
      steps: [...steps(), step({ id: "s3", endpointId: "ep-get" })],
      endpoints,
      scenarioId: "sc1",
      from: 0,
      to: 2,
      runId: 4,
      fetchFn: async (url) => {
        calls += 1;
        return { ok: true, status: 200, text: async () => '{"id":"O-1"}' };
      },
      isCancelled: () => calls >= 1,
    });
    expect(out.cancelled).toBe(true);
    expect(out.results.s3.skipped).toContain("已取消");
  });

  it("fails the step when extraction path is missing", async () => {
    const out = await runChain({
      steps: steps(),
      endpoints,
      scenarioId: "sc1",
      from: 0,
      to: 1,
      runId: 5,
      fetchFn: ok('{"other":1}'),
    });
    expect(out.results.s1.error).toContain("提取失败");
    expect(out.variables.orderId).toBeUndefined();
  });
});

describe("invalidateFrom", () => {
  it("drops results and variables from the edited step onward", async () => {
    const s = steps();
    const out = await runChain({
      steps: s,
      endpoints,
      scenarioId: "sc1",
      from: 0,
      to: 1,
      runId: 1,
      fetchFn: ok('{"id":"O-9"}'),
    });
    const afterEdit0 = invalidateFrom(out, s, 0);
    expect(Object.keys(afterEdit0.results)).toHaveLength(0);
    expect(Object.keys(afterEdit0.variables)).toHaveLength(0);

    const afterEdit1 = invalidateFrom(out, s, 1);
    expect(afterEdit1.results.s1.ok).toBe(true);
    expect(afterEdit1.results.s2).toBeUndefined();
    expect(afterEdit1.variables.orderId?.value).toBe("O-9");
  });
});
