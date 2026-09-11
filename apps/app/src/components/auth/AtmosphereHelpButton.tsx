import { CircleQuestionMarkIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { ControlledResponsiveDialog } from "~/components/ui/responsive-dropdown";

/**
 * The "what is this?" affordance beside the Atmosphere handle label: an
 * icon button that opens a responsive dialog explaining the ecosystem.
 * Rendered by AtprotoHandleField on every surface (sign-in, sign-up, the
 * connections dialog), so the explanation is written once here.
 */

const HELP_TITLE = "What is the Atmosphere?";

const HELP_PARAGRAPHS = [
  "The Atmosphere refers to a family of apps that give you control over your data and allow you to leverage it across different apps. Bluesky is the most popular app in this ecosystem, but the list of apps grows every day.",
  "Your Bluesky handle, or a domain you use as your handle, is your identity across these apps. You can use that handle to sign up for Serial or connect your Atmosphere account to an existing Serial account.",
];

export function AtmosphereHelpButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        type="button"
        aria-label="About the Atmosphere"
        onClick={() => setOpen(true)}
      >
        <CircleQuestionMarkIcon size={14} />
      </Button>
      <ControlledResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        title={HELP_TITLE}
      >
        <div className="text-muted-foreground grid gap-3 text-sm">
          {HELP_PARAGRAPHS.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
      </ControlledResponsiveDialog>
    </>
  );
}
