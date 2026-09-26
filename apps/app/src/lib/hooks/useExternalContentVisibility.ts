"use client";

import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import type { ExternalContentVisibility } from "~/components/content-reader/ExternalContent";
import { isDisconnectedAtom } from "~/lib/data/atoms";
import { useFlagState } from "~/lib/hooks/useFlagState";

/**
 * Whether a reader visit shows External content. Hide is immediate and
 * follows the preference. Offline is a one-way latch per visit: once the
 * visit has been online, frames load and never disappear under the reader,
 * including frames that mount later; a never-online visit shows notices
 * until a connection arrives. The visit is the item, so the latch resets
 * when the reader moves to another item.
 */
export function useExternalContentVisibility(
  itemId: string,
): ExternalContentVisibility {
  const [preference] = useFlagState("ARTICLE_EXTERNAL_CONTENT");
  const offline = useAtomValue(isDisconnectedAtom);
  const [latched, setLatched] = useState<{ itemId: string; online: boolean }>({
    itemId,
    online: !offline,
  });
  useEffect(() => {
    if (offline) return;
    setLatched((current) =>
      current.itemId === itemId && current.online
        ? current
        : { itemId, online: true },
    );
  }, [itemId, offline]);
  const online = latched.itemId === itemId ? latched.online : !offline;
  return preference === "hide" || !online ? "hide" : "show";
}
