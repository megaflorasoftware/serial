import { useQuery } from "@tanstack/react-query";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";
import { getQueryClient, useTRPC, vanillaTRPCClient } from "~/trpc/react";
import { feedsAtom, hasFetchedFeedsAtom } from "../atoms";

import { QueryClient } from "@tanstack/query-core";
import { createCollection } from "@tanstack/db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";

export function useFeedsQuery() {
  const setHasFetchedFeeds = useSetAtom(hasFetchedFeedsAtom);
  const setFeeds = useSetAtom(feedsAtom);

  const query = useQuery(
    useTRPC().feeds.getAll.queryOptions(undefined, {
      staleTime: Infinity,
    }),
  );

  useEffect(() => {
    if (query.isSuccess) {
      setHasFetchedFeeds(true);
      setFeeds(query.data);
    }
  }, [query, setHasFetchedFeeds, setFeeds]);

  return query;
}

export function useFeeds() {
  const [feeds, setFeeds] = useAtom(feedsAtom);
  const hasFetchedFeeds = useAtomValue(hasFetchedFeedsAtom);
  const feedsQuery = useFeedsQuery();

  return {
    feeds,
    setFeeds,
    feedsQuery,
    hasFetchedFeeds,
  };
}
