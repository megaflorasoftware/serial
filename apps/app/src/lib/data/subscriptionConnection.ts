import { getDefaultStore } from "jotai";
import { connectionStateAtom } from "./atoms";

let connected = false;

export function isDataSubscriptionConnected() {
  return connected;
}

export function initializeDataSubscriptionConnection(isOnline: boolean) {
  if (!isOnline) {
    connected = false;
    getDefaultStore().set(connectionStateAtom, "disconnected");
  }
}

export function markDataSubscriptionConnected() {
  connected = true;
  getDefaultStore().set(connectionStateAtom, "connected");
}

export function markDataSubscriptionFailed({
  isOnline,
  isVisible,
}: {
  isOnline: boolean;
  isVisible: boolean;
}) {
  connected = false;
  if (!isOnline || isVisible) {
    getDefaultStore().set(connectionStateAtom, "disconnected");
  }
}

/**
 * The live connection stopped without failing: an intentional hidden-tab
 * pause or a stream the server ended cleanly (proxy idle timeout, deploy
 * rollover). The previous connection state is preserved; only a failed
 * reconnect attempt establishes `disconnected`.
 */
export function markDataSubscriptionPaused() {
  connected = false;
}
