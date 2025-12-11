import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getIsAuthed, getServerAuth } from "~/server/auth";
import {
  AUTH_SIGNED_IN_URL,
  AUTH_SIGNED_OUT_URL,
} from "~/server/auth/constants";

export const Route = createFileRoute("/_app")({
  beforeLoad: async () => {
    const isAuthed = await getIsAuthed();

    if (!isAuthed) {
      throw redirect({
        to: "/auth",
      });
    }
  },
  component: AuthGate,
});

function AuthGate() {
  return <Outlet />;
}
