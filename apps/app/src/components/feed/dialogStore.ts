import { create } from "zustand";
import { canMutateNow } from "~/lib/data/offline-mutations";

export type DialogType =
  | "add-feed"
  | "edit-feed"
  | "edit-bookmark"
  | "add-view"
  | "add-content-category"
  | "custom-video"
  | "edit-user-profile"
  | "connections"
  | "subscription";

export type SubscriptionView = "overview" | "picker";
export type SettingsPane = "main" | "export" | "delete";
export type ConnectionsPane = "list" | "instapaper" | "atproto";

type DialogStore = {
  dialog: null | DialogType;
  selectedFeedId: number | null;
  selectedBookmarkId: string | null;
  subscriptionView: SubscriptionView;
  settingsPane: SettingsPane;
  connectionsPane: ConnectionsPane;
  launchDialog: (
    dialog: DialogType,
    options?: {
      subscriptionView?: SubscriptionView;
      settingsPane?: SettingsPane;
      connectionsPane?: ConnectionsPane;
      selectedFeedId?: number;
      selectedBookmarkId?: string;
    },
  ) => void;
  closeDialog: () => void;
  onOpenChange: (open: boolean) => void;
};

export const useDialogStore = create<DialogStore>((set) => ({
  dialog: null,
  selectedFeedId: null,
  selectedBookmarkId: null,
  subscriptionView: "overview",
  settingsPane: "main",
  connectionsPane: "list",
  launchDialog: (dialog, options) => {
    if (!canMutateNow()) return;
    set({
      dialog,
      subscriptionView: options?.subscriptionView ?? "overview",
      settingsPane: options?.settingsPane ?? "main",
      connectionsPane: options?.connectionsPane ?? "list",
      selectedFeedId: options?.selectedFeedId ?? null,
      selectedBookmarkId: options?.selectedBookmarkId ?? null,
    });
  },
  closeDialog: () => set(CLOSED_STATE),
  onOpenChange: () => set(CLOSED_STATE),
}));

const CLOSED_STATE = {
  dialog: null,
  selectedFeedId: null,
  selectedBookmarkId: null,
  subscriptionView: "overview",
  settingsPane: "main",
  connectionsPane: "list",
} as const;
