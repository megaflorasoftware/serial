import { randomBytes } from "node:crypto";
import { redirect } from "@tanstack/react-router";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { auth } from "~/server/auth";
import { IS_DEMO_INSTANCE } from "~/lib/demo";

export function generateDemoEmail() {
  return `${randomBytes(8).toString("hex")}@example.com`;
}

export async function redirectIfDemoUnauthed() {
  if (!IS_DEMO_INSTANCE) return;

  const headers = getRequestHeaders() as Headers;
  const session = await auth.api.getSession({ headers });
  if (!session) {
    throw redirect({ to: "/api/demo/provision" });
  }
}
