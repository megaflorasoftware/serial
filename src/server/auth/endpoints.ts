import { createServerFn } from "@tanstack/react-start";
import { env } from "~/env";

export const fetchIsForgotPasswordEnabled = createServerFn({
  method: "GET",
}).handler(async () => !!env.SENDGRID_API_KEY);
