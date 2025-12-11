import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Card } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import {
  AUTH_SIGNED_IN_URL,
  AUTH_SIGNED_OUT_URL,
} from "~/server/auth/constants";
import { getIsAuthed, getServerAuth } from "~/server/auth";
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { AuthHeader } from "~/_todo/auth/AuthHeader";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
  beforeLoad: async (params) => {
    const isAuthed = await getIsAuthed();

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
      <div className="absolute top-6 left-6">
        <Link to={AUTH_SIGNED_OUT_URL}>
          <Button variant="outline">⭠ Back to Home</Button>
        </Link>
      </div>
      <div className="grid h-screen w-screen place-items-center p-4">
        <Card className="w-full max-w-md">
          <Tabs
            defaultValue="sign-in"
            className="w-full"
            onValueChange={(value) => {
              console.log(value);
              router.navigate({
                to: `/auth/${value}`,
              });
            }}
          >
            <AuthHeader>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="sign-in">Sign In</TabsTrigger>
                <TabsTrigger value="sign-up">Sign Up</TabsTrigger>
              </TabsList>
            </AuthHeader>
            <Outlet />
          </Tabs>
        </Card>
      </div>
    </>
  );
}
