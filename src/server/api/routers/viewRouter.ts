import { and, asc, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import type { ApplicationView, DatabaseContentCategory } from "~/server/db/schema";
import { sortViewsByPlacement } from "~/lib/data/views/utils";
import {
  INBOX_VIEW_ID,
  INBOX_VIEW_PLACEMENT,
} from "~/lib/data/views/constants";
import {
  FEED_ITEM_ORIENTATION,
  VIEW_CONTENT_TYPE,
  VIEW_READ_STATUS,
} from "~/server/db/constants";

import { protectedProcedure } from "~/server/orpc/base";
import {
  contentCategories,
  createViewSchema,
  deleteViewSchema,
  updateViewSchema,
  viewCategories,
  views,
} from "~/server/db/schema";

function buildUncategorizedView(
  userId: string,
  contentCategoriesList: DatabaseContentCategory[],
  customViews: ApplicationView[],
): ApplicationView {
  const allCategoryIdsSet = new Set(
    contentCategoriesList.map((category) => category.id),
  );
  const customViewCategoryIdsSet = new Set(
    customViews.flatMap((view) => view.categoryIds),
  );

  const uncategorizedCategoryIds = [...allCategoryIdsSet].filter(
    (id) => !customViewCategoryIdsSet.has(id),
  );

  const now = new Date();

  return {
    id: INBOX_VIEW_ID,
    name: "Uncategorized",
    daysWindow: 30,
    orientation: FEED_ITEM_ORIENTATION.HORIZONTAL,
    contentType: VIEW_CONTENT_TYPE.LONGFORM,
    readStatus: VIEW_READ_STATUS.UNREAD,
    placement: INBOX_VIEW_PLACEMENT,
    userId,
    createdAt: now,
    updatedAt: now,
    categoryIds: uncategorizedCategoryIds,
    isDefault: true,
  };
}

export const create = protectedProcedure
  .input(createViewSchema)
  .handler(async ({ context, input }) => {
    await context.db.transaction(async (tx) => {
      const viewsResult = await tx
        .insert(views)
        .values({
          userId: context.user.id,
          name: input.name,
          daysWindow: input.daysWindow,
          readStatus: input.readStatus,
          orientation: input.orientation,
          contentType: input.contentType,
          placement: input.placement,
        })
        .returning();

      const view = viewsResult[0];

      if (!input.categoryIds || !view) return;

      return await Promise.all(
        input.categoryIds.map(async (categoryId) => {
          await tx.insert(viewCategories).values({
            viewId: view.id,
            categoryId,
          });
        }),
      );
    });
  });

export const update = protectedProcedure
  .input(updateViewSchema)
  .handler(async ({ context, input }) => {
    await context.db.transaction(async (tx) => {
      const viewsResult = await tx
        .update(views)
        .set({
          name: input.name,
          daysWindow: input.daysWindow,
          readStatus: input.readStatus,
          orientation: input.orientation,
          contentType: input.contentType,
          placement: input.placement,
        })
        .where(and(eq(views.userId, context.user.id), eq(views.id, input.id)))
        .returning();

      const view = viewsResult[0];

      if (input.categoryIds.length === 0 || !view) return;

      await tx
        .delete(viewCategories)
        .where(
          and(
            eq(viewCategories.viewId, view.id),
            notInArray(viewCategories.categoryId, input.categoryIds),
          ),
        );

      return await Promise.all(
        input.categoryIds.map(async (categoryId) => {
          await tx
            .insert(viewCategories)
            .values({
              viewId: view.id,
              categoryId,
            })
            .onConflictDoNothing();
        }),
      );
    });
  });

export const updatePlacement = protectedProcedure
  .input(
    z.object({
      views: z.array(
        z.object({
          id: z.number(),
          placement: z.number(),
        }),
      ),
    }),
  )
  .handler(async ({ context, input }) => {
    await context.db.transaction(async (tx) => {
      return await Promise.all(
        input.views.map(async (view) => {
          return await tx
            .update(views)
            .set({
              placement: view.placement,
            })
            .where(
              and(eq(views.id, view.id), eq(views.userId, context.user.id)),
            );
        }),
      );
    });
  });

export const deleteView = protectedProcedure
  .input(deleteViewSchema)
  .handler(async ({ context, input }) => {
    await context.db.transaction(async (tx) => {
      await tx
        .delete(viewCategories)
        .where(eq(viewCategories.viewId, input.id));

      return await tx
        .delete(views)
        .where(and(eq(views.id, input.id), eq(views.userId, context.user.id)));
    });
  });

export const getAll = protectedProcedure.handler(async ({ context }) => {
  const [viewsList, viewCategoriesList, contentCategoriesList] =
    await Promise.all([
      context.db
        .select()
        .from(views)
        .where(eq(views.userId, context.user.id))
        .orderBy(asc(views.placement)),
      context.db.select().from(viewCategories),
      context.db
        .select()
        .from(contentCategories)
        .where(eq(contentCategories.userId, context.user.id)),
    ]);

  const customViews: ApplicationView[] = viewsList.map((view) => ({
    ...view,
    isDefault: false,
    categoryIds: viewCategoriesList
      .filter((category) => category.viewId === view.id)
      .map((category) => category.categoryId)
      .filter((id) => id !== null),
  }));

  const inboxView = buildUncategorizedView(
    context.user.id,
    contentCategoriesList,
    customViews,
  );

  return sortViewsByPlacement([...customViews, inboxView]);
});
