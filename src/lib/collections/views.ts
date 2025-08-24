import { useLiveQuery } from "@tanstack/react-db";
import { useTanstackDBContext } from "./TanstackDBProvider";

export function useViewsCollection() {
  return useTanstackDBContext().viewsCollection;
}

export function useViewsLiveQuery() {
  const viewsCollection = useViewsCollection();
  return useLiveQuery((q) => q.from({ view: viewsCollection }));
}
