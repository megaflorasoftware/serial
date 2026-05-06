import { randomBytes } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { auth } from "~/server/auth";
import { IS_DEMO_INSTANCE } from "~/lib/demo";

export const Route = createFileRoute("/api/demo/provision")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!IS_DEMO_INSTANCE) {
          return new Response("Not Found", { status: 404 });
        }

        const session = await auth.api.getSession({
          headers: request.headers,
        });
        if (session) {
          return new Response(null, {
            status: 302,
            headers: { Location: "/" },
          });
        }

        const email = generateDemoEmail();
        const password = randomBytes(16).toString("hex");

        try {
          await auth.api.signUpEmail({
            body: {
              name: "Demo User",
              email,
              password,
            },
            headers: request.headers,
          });
        } catch (error) {
          console.error("[demo] Failed to provision user:", error);
          return new Response("Failed to create demo account", {
            status: 500,
          });
        }

        return new Response(null, {
          status: 302,
          headers: { Location: "/" },
        });
      },
    },
  },
});

function generateDemoEmail() {
  return `${randomBytes(8).toString("hex")}@example.com`;
}
