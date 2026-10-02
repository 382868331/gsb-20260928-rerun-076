// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { App } from "./App";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

function mockFetch(handler: (path: string) => Promise<Response>) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => handler(String(input)));
}

beforeEach(() => {
  vi.restoreAllMocks();
  cleanup();
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

describe("save flow", () => {
  const sc = {
    id: "sc-1",
    name: "订单场景",
    description: "",
    enabled: false,
    endpoints: [
      {
        id: "ep-1",
        name: "e",
        method: "GET",
        path: "/x",
        defaultStatus: 200,
        defaultBody: "{}",
        rules: [],
      },
    ],
    initialState: {},
    createdAt: "",
    updatedAt: "",
  };

  it("stays editable after save even when validate returns null issues", async () => {
    mockFetch((path) => {
      if (path === "/api/scenarios") return Promise.resolve(jsonResponse([sc]));
      if (path === "/api/scenarios/sc-1/validate")
        return Promise.resolve(jsonResponse({ issues: null, valid: true }));
      if (path === "/api/scenarios/sc-1") return Promise.resolve(jsonResponse(sc));
      return Promise.resolve(jsonResponse({}));
    });
    render(<App />);
    await waitFor(() => screen.getByText("订单场景"));
    fireEvent.click(screen.getAllByRole("button", { name: "保存" })[0]);
    await waitFor(() => screen.getByText(/已保存/));
    // page must not go blank: the designer is still there and editable
    expect(screen.getAllByDisplayValue("订单场景").length).toBeGreaterThan(0);
  });

  it("keeps the edits and shows a persistent status when saving fails", async () => {
    mockFetch((path) => {
      if (path === "/api/scenarios") return Promise.resolve(jsonResponse([sc]));
      if (path === "/api/scenarios/sc-1" ) return Promise.resolve(jsonResponse(sc));
      return Promise.resolve(jsonResponse({}));
    });
    // saving fails
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "PUT")
        return Promise.resolve(jsonResponse({ error: "disk full" }, 500));
      if (path === "/api/scenarios") return Promise.resolve(jsonResponse([sc]));
      if (path === "/api/scenarios/sc-1") return Promise.resolve(jsonResponse(sc));
      return Promise.resolve(jsonResponse({}));
    });
    render(<App />);
    await waitFor(() => screen.getByText("订单场景"));
    const nameInput = screen.getAllByDisplayValue("订单场景")[0];
    fireEvent.change(nameInput, { target: { value: "改名后" } });
    fireEvent.click(screen.getAllByRole("button", { name: "保存" })[0]);
    await waitFor(() => screen.getByText(/保存失败/));
    expect(screen.getByText(/本次输入已保留/)).toBeTruthy();
    // the unsaved edit is still in the form, not lost
    expect(screen.getByDisplayValue("改名后")).toBeTruthy();
    void realFetch;
  });
});
