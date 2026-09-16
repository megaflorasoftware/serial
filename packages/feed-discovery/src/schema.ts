import { z } from "zod";
import { discoveredFeedSchema as contract } from "./index";

/** Adapt the shared extension-safe contract for the server's Zod 4 inputs. */
export const discoveredFeedSchema = z.unknown().transform((input, context) => {
  const result = contract.safeParse(input);
  if (result.success) return result.data;
  context.addIssue({ code: "custom", message: "Invalid discovered Feed" });
  return z.NEVER;
});
