// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
