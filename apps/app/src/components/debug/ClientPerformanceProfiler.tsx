"use client";

import { Profiler, useEffect, useState } from "react";
import type { ProfilerOnRenderCallback, PropsWithChildren } from "react";
import { waitForOfflineHydrationIdle } from "~/lib/data/offline-hydration";
import { flushNormalizedPersistence } from "~/lib/data/normalized-idb-storage";

export type ClientPerformanceCommit = {
  phase: "mount" | "update" | "nested-update";
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
};

type ClientPerformanceWindow = Window & {
  __SERIAL_CLIENT_PERFORMANCE__?: {
    commits: ClientPerformanceCommit[];
    readyForWarmReload: () => Promise<void>;
  };
};

export function ClientPerformanceProfiler({ children }: PropsWithChildren) {
  const performanceWindow =
    typeof window === "undefined" ? null : (window as ClientPerformanceWindow);
  // Audit the whole document visit. Re-evaluating this after navigation
  // removes the Profiler boundary and remounts the entire application.
  const [auditEnabled] = useState(
    () =>
      performanceWindow !== null &&
      new URLSearchParams(performanceWindow.location.search).has(
        "client-performance-audit",
      ),
  );

  useEffect(() => {
    if (!auditEnabled || !performanceWindow) return;
    performanceWindow.__SERIAL_CLIENT_PERFORMANCE__ = {
      commits: [],
      readyForWarmReload: async () => {
        await waitForOfflineHydrationIdle();
        await flushNormalizedPersistence();
      },
    };
    return () => {
      delete performanceWindow.__SERIAL_CLIENT_PERFORMANCE__;
    };
  }, [auditEnabled, performanceWindow]);

  if (!auditEnabled || !performanceWindow) return children;

  const recordCommit: ProfilerOnRenderCallback = (
    _id,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
  ) => {
    performanceWindow.__SERIAL_CLIENT_PERFORMANCE__?.commits.push({
      phase,
      actualDuration,
      baseDuration,
      startTime,
      commitTime,
    });
  };

  return (
    <Profiler id="serial-app" onRender={recordCommit}>
      {children}
    </Profiler>
  );
}
