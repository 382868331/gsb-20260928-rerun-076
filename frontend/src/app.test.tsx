// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import React from "react";
import { App } from "./App";
import type { Scenario } from "./types";

function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: "sc1",
    name: "场景一",
    description: "",
    enabled: true,
    endpoints: [
      {
        id: "ep1",
        name: "查询",
        method: "GET",
        path: "/orders/:id",
        defaultStatus: 200,
        defaultHeaders: {},
        defaultBody: '{"ok":true}',
        rules: [],
      },
    ],
    initialState: {},
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("App resilience", () => {
  beforeEach(() => cleanup());
  afterEach(() => vi.restoreAllMocks());

  it("renders an actionable empty state when there are no scenarios", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/api/scenarios")) return jsonResponse([]);
      return new Response("not found", { status: 404 });
    }));
    render(<App />);
    expect(await screen.findByText(/还没有场景/)).toBeTruthy();
    expect(screen.getByText("+ 新建场景")).toBeTruthy();
  });

  it("survives a failed list load without a white screen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    render(<App />);
    expect(await screen.findByText(/场景加载失败/)).toBeTruthy();
    expect(screen.getByText("重新加载")).toBeTruthy();
  });

  it("runs with an existing scenario that already has history", async () => {
    const withHistory = scenario({
      history: [
        {
          seq: 1,
          time: new Date().toISOString(),
          endpointId: "ep1",
          method: "GET",
          path: "/orders/7",
          ruleId: "",
          status: 200,
          delayMs: 0,
        },
      ],
      state: { orderId: "7" },
      counters: { ep1: 1 },
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/api/scenarios")) return jsonResponse([withHistory]);
      if (u.includes("/api/scenarios/sc1")) return jsonResponse(withHistory);
      return new Response("x", { status: 404 });
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "运行调试" }));
    expect(await screen.findByText("调用历史（服务端按场景记录）")).toBeTruthy();
    expect(screen.getByText("/orders/7")).toBeTruthy();
  });

  it("does not reuse path vars or old probe when switching scenarios", async () => {
    const sc1 = scenario();
    const sc2 = scenario({
      id: "sc2",
      name: "场景二",
      endpoints: [
        {
          id: "ep2",
          name: "健康检查",
          method: "GET",
          path: "/health",
          defaultStatus: 200,
          defaultBody: "{}",
          rules: [],
        },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/api/scenarios")) return jsonResponse([sc1, sc2]);
      if (u.includes("/api/scenarios/sc2")) return jsonResponse(sc2);
      if (u.includes("/api/scenarios/sc1")) return jsonResponse(sc1);
      if (u.includes("/mocks/sc1/orders/")) return jsonResponse({ ok: true }, 200);
      if (u.includes("/mocks/sc2/health")) return jsonResponse({ ok: true }, 200);
      return new Response("x", { status: 404 });
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "运行调试" }));
    const idInput = (await screen.findByLabelText(":id")) as HTMLInputElement;
    fireEvent.change(idInput, { target: { value: "OLD-ID" } });
    expect(screen.getByText(/OLD-ID/)).toBeTruthy();

    // switch scenario via sidebar
    fireEvent.click(screen.getByText("场景二"));
    await waitFor(() => expect(screen.queryByText(/OLD-ID/)).toBeNull());
    expect(screen.queryByText("尚未发送请求。")).toBeTruthy();
  });

  it("cancels an in-flight request and keeps the page operable", async () => {
    let rejectFetch: (e: Error) => void = () => {};
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/scenarios")) return Promise.resolve(jsonResponse([scenario()]));
      if (u.includes("/api/scenarios/")) return Promise.resolve(jsonResponse(scenario()));
      const signal = init?.signal;
      if (signal && u.includes("/mocks/")) {
        return new Promise((_res, rej) => {
          rejectFetch = (e: Error) => {
            signal.removeEventListener("abort", abortHandler);
            rej(e);
          };
          const abortHandler = () => rejectFetch(new DOMException("Aborted", "AbortError"));
          signal.addEventListener("abort", abortHandler);
        });
      }
      return Promise.resolve(new Response("x", { status: 404 }));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "运行调试" }));
    const send = await screen.findByRole("button", { name: "发送请求" });
    fireEvent.click(send);
    const cancel = await screen.findByRole("button", { name: "取消请求" });
    fireEvent.click(cancel);
    expect(await screen.findByText(/请求已取消/)).toBeTruthy();
    // page still operable
    expect(screen.getByRole("button", { name: "发送请求" })).toBeTruthy();
  });
});
