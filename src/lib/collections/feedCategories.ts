import { useLiveQuery } from "@tanstack/react-db";
import { useTanstackDBContext } from "./TanstackDBProvider";

export function useFeedCategoriesCollection() {
  return useTanstackDBContext().feedCategoriesCollection;
}

export function useFeedCategoriesLiveQuery() {
  const feedCategoriesCollection = useFeedCategoriesCollection();
  return useLiveQuery((q) =>
    q.from({ feedCategory: feedCategoriesCollection }),
  );
}
