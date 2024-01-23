import { sql } from "drizzle-orm";
import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { contentCategories } from "~/server/db/schema";

export const contentCategoriesRouter = createTRPCRouter({
  create: publicProcedure
    .input(z.object({ name: z.string().min(2) }))
    .mutation(async ({ ctx, input }) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await ctx.db.insert(contentCategories).values({
        userId: ctx.auth!.userId!,
        name: input.name,
      });
    }),

  getAllForUser: publicProcedure.query(async ({ ctx }) => {
    const contentCategories = await ctx.db.query.contentCategories.findMany({
      where: sql`user_id = ${ctx.auth!.userId!}`,
    });

    return contentCategories;
  }),
});
