import { useLiveQuery } from "@tanstack/react-db";
import { useTanstackDBContext } from "./TanstackDBProvider";
import { filtersSchema } from ".";

export function useFiltersCollection() {
  return useTanstackDBContext().filtersCollection;
}

export function useAllFiltersLiveQuery() {
  const filtersCollection = useFiltersCollection();

  const query = useLiveQuery((q) => q.from({ filters: filtersCollection }));

  return {
    ...query,
    data: filtersSchema.parse(query.data),
  };
}
