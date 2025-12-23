import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { fetchIsAuthed } from "~/server/auth";

export const Route = createFileRoute("/_app")({
  beforeLoad: async () => {
    const isAuthed = await fetchIsAuthed();

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
