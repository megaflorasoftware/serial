import { z } from "zod";

/** Reject a malformed container, but keep each independently valid entry. */
export function validEntriesSchema<T>(schema: z.ZodType<T>) {
  return z.array(z.unknown()).transform((entries) =>
    entries.flatMap((entry) => {
      const parsed = schema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    }),
  );
}
