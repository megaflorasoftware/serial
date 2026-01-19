import {   useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {StoreApi, UseBoundStore} from "zustand";

export type ZustandHookSelectors<StateType> = {
  [Key in NonNullable<keyof StateType> as `use${Capitalize<
    string & Key
  >}`]: () => StateType[Key];
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type StoreWithHooks<StateType> = (UseBoundStore<StoreApi<StateType>> | StoreApi<StateType>) &
  Record<string, () => unknown>;

export function createSelectorHooks<StateType extends object>(
  store: UseBoundStore<StoreApi<StateType>> | StoreApi<StateType>,
) {
  const storeIn = store as StoreWithHooks<StateType>;

  Object.keys(storeIn.getState()).forEach((key) => {
    const selector = (state: StateType) => state[key as keyof StateType];
    storeIn[`use${capitalize(key)}`] =
      typeof storeIn === "function"
        ? () => (storeIn as UseBoundStore<StoreApi<StateType>>)(useShallow(selector))
        : () => useStore(storeIn as StoreApi<StateType>, useShallow(selector));
  });

  return storeIn as UseBoundStore<StoreApi<StateType>> &
    ZustandHookSelectors<StateType>;
}
