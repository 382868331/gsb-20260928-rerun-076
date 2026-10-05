import { describe, expect, it } from "vitest";
import { ensureCollections, newScenario } from "./factory";

describe("ensureCollections", () => {
  it("keeps deeply null collections usable after saving or reopening", () => {
    const sc = ensureCollections({
      ...newScenario(),
      id: "sc-1",
      clientId: "draft-1",
      endpoints: [
        {
          id: "ep-1",
          name: "e",
          method: "GET",
          path: "/x",
          defaultStatus: 200,
          defaultBody: "{}",
          rules: [
            {
              id: "rule-1",
              name: "r",
              enabled: true,
              priority: 0,
              nthCall: 0,
              delayMs: 0,
              status: 200,
              body: "{}",
            } as never,
          ],
        },
      ],
    } as never);
    expect(Array.isArray(sc.endpoints[0].rules)).toBe(true);
    expect(sc.endpoints[0].defaultHeaders).toEqual({});
    expect(sc.endpoints[0].rules[0].headers).toEqual({});
    expect(sc.endpoints[0].rules[0].extract).toEqual([]);
    expect(sc.endpoints[0].rules[0].condition).toBeUndefined();
  });
});
