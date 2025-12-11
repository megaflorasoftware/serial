import { env } from "~/env";
import { AUTH_SIGNED_OUT_URL } from "~/server/auth/constants";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { AuthHeader } from "./auth/AuthHeader";

const isForgotPasswordEnabled = !!env.SENDGRID_API_KEY;

import { createFileRoute, Link } from "@tanstack/react-router";
import { AuthResetPageComponent } from "./auth/reset/AuthResetPageComponent";
export const Route = createFileRoute("/auth/reset")({
  component: AuthResetPage,
});

export default function AuthResetPage() {
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
