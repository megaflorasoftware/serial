import { sql } from "drizzle-orm";
import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { feedCategories, feeds } from "~/server/db/schema";
import { fetchFeedData, fetchNewFeedDetails } from "~/server/rss/fetchFeeds";

export const feedRouter = createTRPCRouter({
  create: publicProcedure
    .input(
      z.object({ url: z.string().min(5), categoryId: z.number().optional() }),
    )
    .mutation(async ({ ctx, input }) => {
      const newFeed = await fetchNewFeedDetails(input.url);
      if (!newFeed) {
        throw new Error("Unsupported feed URL");
      }

      const feedRes = await ctx.db.insert(feeds).values({
        userId: ctx.auth!.userId!,
        ...newFeed,
      });

      if (input.categoryId && feedRes.lastInsertRowid) {
        await ctx.db.insert(feedCategories).values({
          feedId: Number(feedRes.lastInsertRowid),
          categoryId: input.categoryId,
        });
      }
    }),

  getAllFeedData: publicProcedure.query(async ({ ctx }) => {
    const feeds = await ctx.db.query.feeds.findMany({
      where: sql`user_id = ${ctx.auth!.userId}`,
    });

    return await fetchFeedData(feeds);
  }),
});
