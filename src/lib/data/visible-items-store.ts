import { createStore } from "zustand";
import { createSelectorHooks } from "./createSelectorHooks";

export type VisibleItemsStore = {
  visibleItemIds: Set<string>;
  addVisibleItemId: (itemId: string) => void;
  removeVisibleItemId: (itemId: string) => void;
  reset: () => void;
};

const vanillaVisibleItemsStore = createStore<VisibleItemsStore>()((set) => ({
  visibleItemIds: new Set<string>(),
  addVisibleItemId: (itemId: string) => {
    set((state) => {
      if (state.visibleItemIds.has(itemId)) return state;
      const newSet = new Set(state.visibleItemIds);
      newSet.add(itemId);
      return { visibleItemIds: newSet };
    });
  },
  removeVisibleItemId: (itemId: string) => {
    set((state) => {
      if (!state.visibleItemIds.has(itemId)) return state;
      const newSet = new Set(state.visibleItemIds);
      newSet.delete(itemId);
      return { visibleItemIds: newSet };
    });
  },
  reset: () => set({ visibleItemIds: new Set<string>() }),
}));

export const visibleItemsStore = createSelectorHooks(vanillaVisibleItemsStore);

export const {
  useVisibleItemIds,
  useAddVisibleItemId,
  useRemoveVisibleItemId,
  useReset: useResetVisibleItems,
} = visibleItemsStore;
