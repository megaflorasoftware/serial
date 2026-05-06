"use client";

import { useEffect, useState } from "react";
import { ClockIcon } from "lucide-react";
import { IS_DEMO_INSTANCE } from "~/lib/demo";

function getNextMidnightUTC() {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
}

function formatCountdown(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

export function DemoBanner() {
  const [countdown, setCountdown] = useState("");

  useEffect(() => {
    if (!IS_DEMO_INSTANCE) return;

    const update = () => {
      const nextMidnight = getNextMidnightUTC();
      const now = new Date();
      const diff = nextMidnight.getTime() - now.getTime();
      setCountdown(formatCountdown(diff));
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);

  if (!IS_DEMO_INSTANCE) {
    return null;
  }

  return (
    <div className="bg-amber-500 text-amber-950 shrink-0">
      <div className="mx-auto flex max-w-7xl items-center justify-center px-4 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ClockIcon size={16} />
          <span>
            This is a demo instance. All data will be deleted in{" "}
            <strong>{countdown}</strong>.
          </span>
        </div>
      </div>
    </div>
  );
}
