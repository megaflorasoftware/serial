import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure } from "~/server/orpc/base";
import { user } from "~/server/db/schema";
import {
  ONBOARDING_STEPS,
  savedOnboardingStep,
} from "~/lib/onboarding/progress";

export const getProgress = protectedProcedure.handler(async ({ context }) => {
  const [progress] = await context.db
    .select({ complete: user.onboardingComplete, step: user.onboardingStep })
    .from(user)
    .where(eq(user.id, context.user.id))
    .limit(1);
  return progress ?? { complete: true, step: null };
});
export const saveProgress = protectedProcedure
  .input(
    z.object({
      complete: z.boolean(),
      step: z
        .string()
        .refine((value) =>
          ONBOARDING_STEPS.some((step) => savedOnboardingStep(step) === value),
        ),
    }),
  )
  .handler(async ({ context, input }) => {
    await context.db
      .update(user)
      .set({ onboardingComplete: input.complete, onboardingStep: input.step })
      .where(
        and(eq(user.id, context.user.id), eq(user.onboardingComplete, false)),
      );
  });
