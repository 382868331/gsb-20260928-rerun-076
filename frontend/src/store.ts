import { create } from "zustand";
import { api } from "./api";
import type { Issue, RunState, Scenario } from "./types";

export const uid = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function emptyScenario(): Scenario {
  return {
    id: "",
    name: "新场景",
    description: "",
    initialVars: {},
    endpoints: [],
    rules: [],
  };
}

interface State {
  list: Scenario[];
  current: Scenario | null;
  issues: Issue[];
  runState: RunState | null;
  loading: boolean;
  message: string;
  loadList: () => Promise<void>;
  open: (id: string) => Promise<void>;
  newScenario: () => void;
  updateCurrent: (mut: (s: Scenario) => void) => void;
  save: () => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  validate: () => Promise<void>;
  refreshState: () => Promise<void>;
  resetState: () => Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  list: [],
  current: null,
  issues: [],
  runState: null,
  loading: false,
  message: "",

  loadList: async () => {
    const list = await api.list();
    set({ list });
  },

  open: async (id) => {
    const sc = await api.get(id);
    const result = await api.validate(id, sc).catch(() => ({ issues: [], canEnable: false }));
    const runState = await api.state(id).catch(() => null);
    set({ current: sc, issues: result.issues, runState });
  },

  newScenario: () => set({ current: emptyScenario(), issues: [], runState: null }),

  updateCurrent: (mut) => {
    const cur = get().current;
    if (!cur) return;
    const copy: Scenario = JSON.parse(JSON.stringify(cur));
    mut(copy);
    set({ current: copy });
  },

  save: async () => {
    const cur = get().current;
    if (!cur) return false;
    try {
      let saved = cur;
      if (cur.id) {
        saved = await api.update(cur.id, cur);
      } else {
        saved = await api.create(cur);
      }
      const result = await api.validate(saved.id, saved);
      const runState = await api.state(saved.id).catch(() => null);
      set({
        current: saved,
        issues: result.issues,
        runState,
        message: `已保存 ${new Date().toLocaleTimeString()}`,
      });
      await get().loadList();
      return true;
    } catch (err) {
      set({ message: `保存失败: ${(err as Error).message}` });
      return false;
    }
  },

  remove: async (id) => {
    await api.remove(id);
    if (get().current?.id === id) set({ current: null, runState: null, issues: [] });
    await get().loadList();
  },

  validate: async () => {
    const cur = get().current;
    if (!cur || !cur.id) return;
    const result = await api.validate(cur.id, cur);
    set({ issues: result.issues });
  },

  refreshState: async () => {
    const cur = get().current;
    if (!cur?.id) return;
    set({ runState: await api.state(cur.id) });
  },

  resetState: async () => {
    const cur = get().current;
    if (!cur?.id) return;
    set({ runState: await api.reset(cur.id) });
  },
}));
