"use client";

import clsx from "clsx";
import { useAtomValue } from "jotai";
import { useLocation, useRouter } from "@tanstack/react-router";
import { HeaderCenterContent } from "./HeaderCenterContent";
import { TopLeftButton } from "./TopLeftButton";
import { TopRightHeaderContent } from "./TopRightHeaderContent";
import { barsHiddenAtom } from "~/lib/data/atoms";
import { useShortcut } from "~/lib/hooks/useShortcut";

export function Header() {
  const location = useLocation();
  const router = useRouter();
  const barsHidden = useAtomValue(barsHiddenAtom);

  const isContentPage =
    location.pathname.includes("/read/") ||
    location.pathname.includes("/watch/");

  useShortcut("h", () => {
    if (location.pathname === "/") return;
    void router.navigate({
      to: "/",
    });
  });

  return (
    <header
      className={clsx(
        "top-0 z-20 flex w-full flex-wrap items-center justify-between gap-2 bg-transparent px-6 pt-5 pb-6 md:pt-6",
        {
          "sticky transition-transform duration-300": isContentPage,
          "-translate-y-full": isContentPage && barsHidden,
        },
      )}
    >
      <span className="inline-flex w-auto items-center justify-start md:w-16">
        <TopLeftButton />
      </span>
      <span className="flex min-w-0 flex-1 items-center justify-center">
        <HeaderCenterContent />
      </span>
      <span className="inline-flex w-auto items-center justify-end md:w-16">
        <TopRightHeaderContent />
      </span>
    </header>
  );
}
