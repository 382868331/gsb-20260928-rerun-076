import { describe, it, expect } from "vitest";
import { expandTemplate, containsTemplate } from "./template";

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

  it("expands state tokens including dot paths and fallbacks", () => {
    const state = { orderId: "X1", order: { id: "X2" } };
    expect(expandTemplate(`{"id":"{{state.orderId}}"}`, state)).toBe('{"id":"X1"}');
    expect(expandTemplate(`{{state.order.id}}`, state)).toBe("X2");
    expect(expandTemplate(`{{state.missing ?? 'none'}}`, state)).toBe("none");
    expect(expandTemplate(`{{state.missing}}`, state)).toBe("");
    expect(containsTemplate(`{{state.x}}`)).toBe(true);
    expect(containsTemplate(`plain`)).toBe(false);
  });
});
