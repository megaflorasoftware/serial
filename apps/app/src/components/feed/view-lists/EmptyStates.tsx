"use client";

import { SproutIcon } from "lucide-react";

export function EmptyState() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 md:py-6">
      <div className="bg-muted flex w-full flex-col items-center justify-center rounded p-12">
        <SproutIcon size={40} />
        <h2 className="pt-2 text-lg font-semibold">
          You&apos;ve seen everything!
        </h2>
        <p className="max-w-xs pt-1 text-center text-sm opacity-80">
          Take a walk, buy a sweet treat, or do something else that will make
          you happy today.
        </p>
      </div>
    </div>
  );
}
