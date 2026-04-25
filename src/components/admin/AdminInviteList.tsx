"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { Loader2Icon, MailIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { orpc } from "~/lib/orpc";

type InviteStatus = "pending" | "accepted" | "canceled" | "expired";

const STATUS_VARIANTS: Record<
  InviteStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "outline",
  accepted: "secondary",
  canceled: "destructive",
  expired: "destructive",
};

const STATUS_LABELS: Record<InviteStatus, string> = {
  pending: "Pending",
  accepted: "Accepted",
  canceled: "Canceled",
  expired: "Expired",
};

function getDisplayStatus(status: string, expiresAt: Date): InviteStatus {
  if (status === "pending" && new Date(expiresAt) < new Date()) {
    return "expired";
  }
  return status as InviteStatus;
}

export function AdminInviteList() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery(
    orpc.admin.listInvitations.queryOptions(),
  );

  const deleteMutation = useMutation(
    orpc.admin.deleteInvitation.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: orpc.admin.listInvitations.queryKey(),
        });
        toast.success("Invitation deleted");
      },
      onError: (error) => {
        toast.error(error.message || "Failed to delete invitation");
      },
    }),
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2Icon className="animate-spin" size={24} />
      </div>
    );
  }

  const invitations = data?.invitations ?? [];

  if (invitations.length === 0) {
    return (
      <p className="text-muted-foreground py-8 text-center">
        No invitations yet
      </p>
    );
  }

  return (
    <div className="-mx-3 flex flex-col">
      {invitations.map((invite) => {
        const displayStatus = getDisplayStatus(invite.status, invite.expiresAt);

        return (
          <div
            key={invite.id}
            className="flex items-center justify-between gap-3 rounded-lg px-3 py-3"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-2">
                {invite.email ? (
                  <span className="flex items-center gap-1.5 truncate font-medium">
                    <MailIcon
                      size={14}
                      className="text-muted-foreground shrink-0"
                    />
                    {invite.email}
                  </span>
                ) : (
                  <span className="text-muted-foreground truncate font-medium">
                    No email
                  </span>
                )}
                <Badge variant={STATUS_VARIANTS[displayStatus]}>
                  {STATUS_LABELS[displayStatus]}
                </Badge>
              </div>
              <span className="text-muted-foreground text-sm">
                Created {dayjs(invite.createdAt).format("MMM D, YYYY")}
                {invite.inviterName ? ` by ${invite.inviterName}` : ""}
                {displayStatus === "pending" &&
                  ` \u00b7 Expires ${dayjs(invite.expiresAt).format("MMM D, YYYY")}`}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete invitation"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate({ invitationId: invite.id })}
            >
              <Trash2Icon size={16} className="text-muted-foreground" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
