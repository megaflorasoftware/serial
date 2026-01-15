import {
  createFileRoute,
  Outlet,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { Card } from "~/components/ui/card";
import { AUTH_SIGNED_IN_URL } from "~/server/auth/constants";
import { fetchIsAuthed } from "~/server/auth/endpoints";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
  beforeLoad: async (params) => {
    const isAuthed = await fetchIsAuthed();

    if (isAuthed) {
      throw redirect({
        to: AUTH_SIGNED_IN_URL,
      });
    }

    const isBasePath =
      params.location.pathname === "/auth" ||
      params.location.pathname === "/auth/";

    if (isBasePath) {
      throw redirect({
        to: "/auth/sign-in",
      });
    }
  },
});

function AuthPage() {
  const router = useRouter();

  return (
    <>
      <div className="grid h-screen w-screen place-items-center p-4">
        <Card className="w-full max-w-md">
          <Outlet />
        </Card>
      </div>
    </>
  );
}
