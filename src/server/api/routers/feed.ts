import { sql } from "drizzle-orm";
import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { feeds } from "~/server/db/schema";
import { fetchNewFeedDetails, fetchFeedData } from "~/server/rss/fetchFeeds";

export const feedRouter = createTRPCRouter({
  hello: publicProcedure
    .input(z.object({ text: z.string() }))
    .query(({ input }) => {
      return {
        greeting: `Hello ${input.text}`,
      };
    }),

  create: publicProcedure
    .input(z.object({ url: z.string().min(5) }))
    .mutation(async ({ ctx, input }) => {
      const newFeed = await fetchNewFeedDetails(input.url);
      if (!newFeed) {
        throw new Error("Unsupported feed URL");
      }

      await ctx.db.insert(feeds).values({
        userId: ctx.auth.userId!,
        ...newFeed,
      });
    }),

  getAllFeedData: publicProcedure.query(async ({ ctx }) => {
    const feeds = await ctx.db.query.feeds.findMany({
      where: sql`user_id = ${ctx.auth.userId}`,
    });

    return await fetchFeedData(feeds);
  }),
});
