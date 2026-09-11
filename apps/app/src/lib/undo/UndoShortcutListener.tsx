import { useCallback } from "react";
import { toast } from "sonner";
import { undoStore } from "./store";
import { canMutateNow } from "~/lib/data/offline-mutations";
import { useShortcut } from "~/lib/hooks/useShortcut";
import { SHORTCUT_KEYS } from "~/lib/constants/shortcuts";

export function UndoShortcutListener() {
  const handleUndo = useCallback(() => {
    const state = undoStore.getState();
    const activeUndo = state.activeUndo;
    const activeToastId = state.activeToastId;

    if (!activeUndo || activeToastId === null) return;
    // An undo replays a server mutation; while disconnected the toast stays
    // so the shortcut can pick it up once the connection returns.
    if (!canMutateNow()) return;

    toast.dismiss(activeToastId);
    undoStore.getState().clearActiveUndo();

    void Promise.resolve(activeUndo.onUndo()).catch(() => {
      toast.error("Failed to undo action");
    });
  }, []);

  useShortcut(SHORTCUT_KEYS.UNDO, handleUndo);

  return null;
}
