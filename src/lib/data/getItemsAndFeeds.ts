"use server";

import { api } from "~/trpc/server";

export async function getItemsAndFeeds() {
  return await api.feed.getAllFeedData.query();
}
