import { env } from "~/env";
import { AUTH_SIGNED_OUT_URL } from "~/server/auth/constants";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";

const isForgotPasswordEnabled = !!env.SENDGRID_API_KEY;

import { createFileRoute, Link } from "@tanstack/react-router";
import { AuthHeader } from "~/_todo/auth/AuthHeader";
import { AuthResetPageComponent } from "~/_todo/auth/reset/AuthResetPageComponent";
export const Route = createFileRoute("/auth/reset")({
  component: AuthResetPage,
  loader: async () => {
    const isForgotPasswordEnabled = !!env.SENDGRID_API_KEY;

    return { isForgotPasswordEnabled };
  },
  validateSearch: (search: Record<string, unknown>) => {
    // validate and parse the search params into a typed state
    return {
      page: search?.token ?? "",
      email: search?.email ?? "",
    };
  },
});

export default function AuthResetPage() {
  const { isForgotPasswordEnabled } = Route.useLoaderData();

  if (!isForgotPasswordEnabled) {
    return (
      <>
        <div className="absolute top-6 left-6">
          <Link to={AUTH_SIGNED_OUT_URL}>
            <Button variant="outline">⭠ Back to Home</Button>
          </Link>
        </div>
        <div className="grid h-screen w-screen place-items-center p-4">
          <Card className="w-full max-w-md">
            <AuthHeader>
              <p className="text-center font-semibold">Reset Password</p>
              <p className="mx-auto max-w-xs text-center">
                Resetting your password is unavailable at this time. Please
                contact your admin for more assistance.
              </p>
            </AuthHeader>
          </Card>
        </div>
      </>
    );
  }

  return <AuthResetPageComponent />;
}
