import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { polarClient } from "@polar-sh/better-auth/client";
import { IS_MAIN_INSTANCE } from "~/lib/constants";

const plugins = IS_MAIN_INSTANCE
  ? [adminClient(), polarClient()]
  : [adminClient()];

export const authClient = createAuthClient({
  plugins,
});

export const { signIn, signOut, signUp, useSession, resetPassword } =
  authClient;
