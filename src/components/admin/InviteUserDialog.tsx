"use client";

import { useMutation } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ControlledResponsiveDialog } from "~/components/ui/responsive-dropdown";
import { orpc } from "~/lib/orpc";

export function InviteUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}) {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [invitationId, setInvitationId] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [copied, setCopied] = useState(false);

  const createMutation = useMutation(
    orpc.admin.createInvitation.mutationOptions({
      onSuccess: (result) => {
        setInviteUrl(result.inviteUrl);
        setInvitationId(result.id);
        onCreated?.();
      },
      onError: (error) => {
        toast.error(error.message || "Failed to create invitation");
      },
    }),
  );

  const sendMutation = useMutation(
    orpc.admin.sendInvitationEmail.mutationOptions({
      onSuccess: () => {
        toast.success("Invitation email sent!");
        setEmail("");
      },
      onError: (error) => {
        toast.error(error.message || "Failed to send invitation email");
      },
    }),
  );

  const handleClose = (value: boolean) => {
    onOpenChange(value);
    if (!value) {
      setInviteUrl(null);
      setInvitationId(null);
      setEmail("");
      setCopied(false);
    }
  };

  const handleCopy = async () => {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <ControlledResponsiveDialog
      open={open}
      onOpenChange={handleClose}
      title="Invite User"
      description="Create a one-time sign-up link to share with a new user."
    >
      {!inviteUrl ? (
        <Button
          className="w-full"
          disabled={createMutation.isPending}
          onClick={() => createMutation.mutate({})}
        >
          {createMutation.isPending ? (
            <Loader2Icon size={16} className="animate-spin" />
          ) : (
            "Create invite link"
          )}
        </Button>
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label>Invite link</Label>
            <button
              type="button"
              onClick={handleCopy}
              className="hover:bg-muted/50 cursor-pointer rounded-md border text-left transition-colors"
            >
              <pre className="overflow-x-auto p-3">
                <code className="text-xs break-all whitespace-pre-wrap">
                  {inviteUrl}
                </code>
              </pre>
            </button>
            <p className="text-muted-foreground text-xs">
              {copied
                ? "Copied to clipboard!"
                : "Click to copy. This link can only be used once."}
            </p>
          </div>

          <div className="border-t pt-4">
            <Label htmlFor="invite-email" className="mb-2 block">
              Send via email (optional)
            </Label>
            <div className="flex gap-2">
              <Input
                id="invite-email"
                type="email"
                placeholder="user@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button
                disabled={!email || sendMutation.isPending || !invitationId}
                onClick={() =>
                  sendMutation.mutate({
                    invitationId: invitationId!,
                    email,
                  })
                }
              >
                {sendMutation.isPending ? (
                  <Loader2Icon size={16} className="animate-spin" />
                ) : (
                  "Send"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ControlledResponsiveDialog>
  );
}
