import { createFileRoute, redirect } from "@tanstack/react-router";
import { getServerAuth } from "~/server/auth";
import {
  AUTH_SIGNED_IN_URL,
  AUTH_SIGNED_OUT_URL,
} from "~/server/auth/constants";

export const Route = createFileRoute("/")({
  server: {
    handlers: {
      GET: async (params) => {
        const auth = await getServerAuth(params.request.headers);

        if (auth?.session.id) {
          return redirect({
            to: AUTH_SIGNED_IN_URL,
          });
        }

        return redirect({
          to: AUTH_SIGNED_OUT_URL,
        });
      },
    },
  },
});
