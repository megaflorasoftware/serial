import { api } from "~/trpc/server";
import { PropsWithChildren } from "react";
import { FeedProvider } from "./FeedProvider";

export async function FeedProviderServer({ children }: PropsWithChildren) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const data = await api.feed.getAllFeedData.query();

  return <FeedProvider data={data}>{children}</FeedProvider>;
}
