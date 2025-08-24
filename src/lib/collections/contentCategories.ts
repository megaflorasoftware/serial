import { useLiveQuery } from "@tanstack/react-db";
import { useTanstackDBContext } from "./TanstackDBProvider";

export function useContentCategoriesCollection() {
  return useTanstackDBContext().contentCategoriesCollection;
}

export function useContentCategoriesLiveQuery() {
  const contentCategoriesCollection = useContentCategoriesCollection();
  return useLiveQuery((q) =>
    q.from({ contentCategory: contentCategoriesCollection }),
  );
}
