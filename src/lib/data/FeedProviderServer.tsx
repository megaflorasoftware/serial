import { api } from "~/trpc/server";
import { type PropsWithChildren } from "react";
import { FeedProvider } from "./FeedProvider";

export async function FeedProviderServer({ children }: PropsWithChildren) {
  const data = await api.feed.getAllFeedData.query();

  return <FeedProvider data={data}>{children}</FeedProvider>;
}
