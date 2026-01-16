import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { Card } from "~/components/ui/card";
import { authMiddleware } from "~/server/auth";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
  server: {
    middleware: [authMiddleware],
  },
});

function AuthPage() {
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
