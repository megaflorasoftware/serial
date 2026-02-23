import { Polar } from "@polar-sh/sdk";
import { IS_MAIN_INSTANCE } from "~/lib/constants";

export const polarClient =
  IS_MAIN_INSTANCE && process.env.POLAR_ACCESS_TOKEN
    ? new Polar({
        accessToken: process.env.POLAR_ACCESS_TOKEN,
        server:
          process.env.NODE_ENV === "production" ? "production" : "sandbox",
      })
    : null;
