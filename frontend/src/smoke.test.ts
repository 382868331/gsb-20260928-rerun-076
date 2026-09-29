import { describe, it, expect } from "vitest";

// Mirror of the backend template token rules, used by the UI help text.
describe("platform basics", () => {
  it("builds mock URLs from scenario id and path", () => {
    const build = (id: string, path: string) => `/mocks/${id}${path}`;
    expect(build("sc-1", "/orders/9")).toBe("/mocks/sc-1/orders/9");
  });

  it("detects state references in templates", () => {
    const refs = (tpl: string) => [...tpl.matchAll(/{{\s*state\.([\w.-]+)/g)].map((m) => m[1]);
    expect(refs(`{"a":"{{state.orderId}}","b":{{state.count}}`)).toEqual(["orderId", "count"]);
  });
});
