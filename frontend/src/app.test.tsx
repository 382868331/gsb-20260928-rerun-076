// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

function mockFetch(handler: (path: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)
  );
}

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("App first-use states", () => {
  it("shows the create entry instead of a white screen when the list is empty", async () => {
    mockFetch((path) => {
      if (path === "/api/scenarios") return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({}));
    });
    render(<App />);
    await waitFor(() => screen.getByText("+ 新建第一个场景"));
    expect(screen.getByText("+ 新建场景")).toBeTruthy();
  });

  it("shows a retryable error when the list fails to load", async () => {
    mockFetch(() => Promise.reject(new Error("network down")));
    render(<App />);
    await waitFor(() => screen.getByText(/场景列表加载失败/));
    expect(screen.getByText("重试")).toBeTruthy();
  });

  it("renders scenarios whose collections came back as null", async () => {
    const bare = {
      id: "sc-1",
      name: "裸场景",
      description: "",
      enabled: false,
      endpoints: null,
      initialState: null,
      createdAt: "",
      updatedAt: "",
    };
    mockFetch((path) => {
      if (path === "/api/scenarios") return Promise.resolve(jsonResponse([bare]));
      if (path === "/api/scenarios/sc-1")
        return Promise.resolve(
          jsonResponse({
            ...bare,
            endpoints: [
              {
                id: "ep-1",
                name: "e",
                method: "GET",
                path: "/x",
                defaultStatus: 200,
                defaultBody: "{}",
                rules: null,
              },
            ],
          })
        );
      return Promise.resolve(jsonResponse({}));
    });
    render(<App />);
    await waitFor(() => screen.getByText("裸场景"));
    await waitFor(() => screen.getByText(/条启用规则/));
  });
});

import { fireEvent } from "@testing-library/react";

const scenario = {
  id: "sc-1",
  name: "订单场景",
  description: "",
  enabled: false,
  endpoints: [
    {
      id: "ep-1",
      name: "创建",
      method: "POST",
      path: "/orders",
      defaultStatus: 201,
      defaultBody: "{}",
      rules: [],
    },
  ],
  initialState: {},
  createdAt: "",
  updatedAt: "",
  state: {},
  counters: {},
  history: [],
};

describe("save flow", () => {
  it("keeps editing normally after a successful save, even if validate returns null issues", async () => {
    mockFetch((path, init) => {
      if (path === "/api/scenarios") return Promise.resolve(jsonResponse([scenario]));
      if (path === "/api/scenarios/sc-1" && (!init || !init.method)) {
        return Promise.resolve(jsonResponse(scenario));
      }
      if (path === "/api/scenarios/sc-1" && init?.method === "PUT") {
        return Promise.resolve(jsonResponse(scenario));
      }
      if (path === "/api/scenarios/sc-1/validate") {
        // the old bug: null issues crashed the whole page after saving
        return Promise.resolve(jsonResponse({ issues: null, valid: true }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<App />);
    await waitFor(() => screen.getByText("订单场景"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => screen.getByText(/已保存/));
    // the designer is still there: editing continues, no blank page
    expect(screen.getByDisplayValue("订单场景")).toBeTruthy();
  });

  it("keeps the current input and selection when the save is rejected", async () => {
    mockFetch((path, init) => {
      if (path === "/api/scenarios") return Promise.resolve(jsonResponse([scenario]));
      if (path === "/api/scenarios/sc-1" && init?.method === "PUT") {
        return Promise.resolve(jsonResponse({ error: "场景名称不能为空" }, 400));
      }
      if (path === "/api/scenarios/sc-1") return Promise.resolve(jsonResponse(scenario));
      return Promise.resolve(jsonResponse({}));
    });
    render(<App />);
    await waitFor(() => screen.getByText("订单场景"));
    const nameInput = screen.getByLabelText("场景名称");
    fireEvent.change(nameInput, { target: { value: "改过的名字" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => screen.getByText(/保存失败/));
    // the rejected input is still there, and we are still on the same scenario
    expect(screen.getByDisplayValue("改过的名字")).toBeTruthy();
    expect(screen.getByText(/有未保存修改/)).toBeTruthy();
  });

  it("distinguishes an unconfirmed save and lets the user re-confirm it", async () => {
    mockFetch((path, init) => {
      if (path === "/api/scenarios") return Promise.resolve(jsonResponse([scenario]));
      if (path === "/api/scenarios/sc-1" && init?.method === "PUT") {
        // network drop: no response at all
        return Promise.reject(new Error("network failed"));
      }
      if (path === "/api/scenarios/sc-1") return Promise.resolve(jsonResponse(scenario));
      return Promise.resolve(jsonResponse({}));
    });
    render(<App />);
    await waitFor(() => screen.getByText("订单场景"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => screen.getByText(/保存结果未确认/));
    fireEvent.click(screen.getByText("重新确认"));
    await waitFor(() => screen.getByText(/已保存/));
  });
});
