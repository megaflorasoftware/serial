import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Card } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import {
  AUTH_SIGNED_IN_URL,
  AUTH_SIGNED_OUT_URL,
} from "~/server/auth/constants";
import { getServerAuth } from "~/server/auth";
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AuthHeader } from "~/_todo/auth/AuthHeader";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
  loader: async (params) => {
    const auth = await getServerAuth();

    if (!!auth?.session.id) {
      throw redirect({
        to: AUTH_SIGNED_IN_URL,
      });
    }
  },
});

function AuthPage() {
  return (
    <>
      <div className="absolute top-6 left-6">
        <Link to={AUTH_SIGNED_OUT_URL}>
          <Button variant="outline">⭠ Back to Home</Button>
        </Link>
      </div>
      <div className="grid h-screen w-screen place-items-center p-4">
        <Card className="w-full max-w-md">
          <Tabs defaultValue="sign-in" className="w-full">
            <AuthHeader>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="sign-in">
                  <Link to="/auth/sign-in">Sign In</Link>
                </TabsTrigger>
                <TabsTrigger value="sign-up">
                  <Link to="/auth/sign-up">Sign Up</Link>
                </TabsTrigger>
              </TabsList>
            </AuthHeader>
            <Outlet />
          </Tabs>
        </Card>
      </div>
    </>
  );
}
