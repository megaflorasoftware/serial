import { useState } from "react";
import { toast } from "sonner";
import type { AtprotoHandleSubmission } from "~/components/auth/AtprotoHandleField";
import type { AuthIntent } from "~/lib/auth/method-view";
import { AtprotoHandleField } from "~/components/auth/AtprotoHandleField";
import { authClient } from "~/lib/auth-client";
import { AUTH_SIGNED_IN_URL } from "~/lib/auth/constants";

/**
 * The Atmosphere (AT Protocol) entry point on the auth pages: the shared
 * handle step (AtprotoHandleField) wired to the authorize endpoint.
 * Rendered expanded — inline when Atmosphere is the primary method, and
 * inside the secondary-method subscreen otherwise. A non-default
 * `signedInDestination` (the extension connect page) rides the encrypted
 * state payload through the OAuth round trip, so the callback lands there
 * like the other sign-in methods do.
 */

const AUTHORIZE_PATH = "/atproto/authorize";

const GENERIC_ERROR_MESSAGE =
  "Could not start Atmosphere sign in. Please try again.";

const HANDLE_LABELS: Record<AuthIntent, string> = {
  "sign-in": "Login with your Atmosphere handle",
  "sign-up": "Sign up with your Atmosphere handle",
};

interface AtprotoAuthFormProps {
  intent: AuthIntent;
  /** The page's own submission state; busy-ness here stays internal. */
  disabled: boolean;
  signedInDestination: string;
  focusOnMount?: boolean;
}

export function AtprotoAuthForm({
  intent,
  disabled,
  signedInDestination,
  focusOnMount = false,
}: AtprotoAuthFormProps) {
  const [busy, setBusy] = useState(false);

  const submit = async (submission: AtprotoHandleSubmission) => {
    if (busy || disabled) return;
    setBusy(true);

    // An HTTP error resolves to { error }; a transport failure (offline,
    // DNS) rejects. Both degrade to a toast, and busy stays set only when
    // the redirect is actually underway.
    let redirectStarted = false;
    try {
      const { data, error } = await authClient.$fetch<{ url: string }>(
        AUTHORIZE_PATH,
        {
          method: "POST",
          body: {
            identifier: submission.identifier,
            ...(submission.did ? { did: submission.did } : {}),
            ...(signedInDestination !== AUTH_SIGNED_IN_URL
              ? { callbackURL: signedInDestination }
              : {}),
          },
        },
      );

      if (error || !data?.url) {
        toast.error(error?.message ?? GENERIC_ERROR_MESSAGE);
        return;
      }
      redirectStarted = true;
      window.location.assign(data.url);
    } catch {
      toast.error(GENERIC_ERROR_MESSAGE);
    } finally {
      // Deliberately conditional: once the redirect is underway the form
      // must stay busy until the page unloads.
      // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally
      if (!redirectStarted) setBusy(false);
    }
  };

  return (
    <AtprotoHandleField
      id="atproto-identifier"
      label={HANDLE_LABELS[intent]}
      submitLabel="Continue"
      submitVariant="default"
      size="lg"
      busy={busy}
      disabled={disabled}
      focusOnMount={focusOnMount}
      onSubmit={(submission) => void submit(submission)}
    />
  );
}
