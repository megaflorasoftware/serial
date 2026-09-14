"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { NAVIGATION_CACHE_INVALIDATED_MESSAGE } from "~/lib/pwa/navigation-cache";

function showUpdatePrompt(reg: ServiceWorkerRegistration) {
  const toastId = toast("A new version of Serial is available!", {
    action: (
      <Button
        size="sm"
        onClick={() => {
          // Tell the waiting service worker to skip waiting
          reg.waiting?.postMessage({ type: "SKIP_WAITING" });
          toast.dismiss(toastId);
        }}
      >
        Update
      </Button>
    ),
    cancel: (
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          toast.dismiss(toastId);
        }}
      >
        Later
      </Button>
    ),
    duration: Infinity,
  });
}

function isNavigationCacheInvalidation(event: MessageEvent<unknown>) {
  const data = event.data;
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === NAVIGATION_CACHE_INVALIDATED_MESSAGE
  );
}

/**
 * The worker serves the cached application shell before revalidating it.
 * When that revalidation finds the session has ended (the server redirected
 * the document), this page booted from a shell it can no longer use;
 * reloading follows the server redirect to sign-in.
 */
function useReloadOnNavigationCacheInvalidation() {
  useEffect(() => {
    const container =
      typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
    const reloadOnInvalidation = (event: MessageEvent<unknown>) => {
      if (isNavigationCacheInvalidation(event)) window.location.reload();
    };
    container?.addEventListener("message", reloadOnInvalidation);
    // Worker messages queue until the page opts in; the invalidation may be
    // posted before hydration reaches this effect.
    container?.startMessages();
    return () => {
      container?.removeEventListener("message", reloadOnInvalidation);
    };
  }, []);
}

export function ReloadPrompt() {
  const hasPromptedRef = useRef(false);
  useReloadOnNavigationCacheInvalidation();

  // Cleanup aborts the controller whose signal owns every registration
  // listener added below.
  // oxlint-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    const abortController = new AbortController();

    const registerServiceWorker = async () => {
      try {
        // Track whether a SW was already controlling this page. On a fresh
        // install the controller is null; on an update it's the old SW.
        // We use this to distinguish first-install (don't reload — the
        // activate handler warms the cache) from updates (reload to pick up
        // the new SW).
        const hadController = !!navigator.serviceWorker.controller;

        const reg = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
        });

        if (abortController.signal.aborted) return;

        // Check for updates
        reg.addEventListener(
          "updatefound",
          () => {
            const newWorker = reg.installing;
            if (!newWorker) return;

            newWorker.addEventListener(
              "statechange",
              () => {
                if (
                  newWorker.state === "installed" &&
                  navigator.serviceWorker.controller
                ) {
                  // New content is available, show update prompt
                  if (!hasPromptedRef.current) {
                    hasPromptedRef.current = true;
                    showUpdatePrompt(reg);
                  }
                }
              },
              { signal: abortController.signal },
            );
          },
          { signal: abortController.signal },
        );

        // Handle controller change (after skipWaiting on update).
        // On first install, clients.claim() fires controllerchange (null →
        // new SW). We intentionally skip the reload in that case to avoid a
        // jarring double page-load — the activate handler already warms the
        // navigation cache for offline support.
        let refreshing = false;
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          () => {
            if (!refreshing && hadController) {
              refreshing = true;
              window.location.reload();
            }
          },
          { signal: abortController.signal },
        );

        // iOS Safari: force an update check. Safari caches the SW script
        // itself more aggressively than Chrome, so an explicit update()
        // ensures the user gets the latest SW on each visit.
        await reg.update().catch(() => {
          // Non-critical — the browser will still check within 24 hours.
        });

        // iOS Safari: re-warm the navigation cache on every launch. iOS
        // evicts all cached data after ~7 days of inactivity. The activate
        // handler only runs once (on install/update), so each online visit
        // needs to reset that clock by re-caching the root page.
        const activeWorker = reg.active ?? reg.installing ?? reg.waiting;
        activeWorker?.postMessage({ type: "WARM_NAVIGATION_CACHE" });
      } catch (error) {
        console.error("Service worker registration failed:", error);
      }
    };

    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      void registerServiceWorker();
    }

    return () => abortController.abort();
  }, []);

  return null;
}
