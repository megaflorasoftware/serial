"use client";

import { DatetimeDisplay } from "~/components/DatetimeDisplay";

import { FeedProvider } from "~/components/FeedProvider";
import { KeyboardProvider } from "~/components/KeyboardProvider";
import MainPanel from "./MainPanel";
import { TopLeftButton } from "./TopLeftButton";
import { TopRightHeaderContent } from "./TopRightHeaderContent";
import { CategoriesSheet } from "~/components/CategoriesSheet";

export default function Home() {
  return (
    <FeedProvider>
      <KeyboardProvider>
        <main className="flex h-screen flex-col">
          <header className="sticky top-0 z-20 flex h-20 w-full items-center justify-between border-b bg-background px-6">
            <TopLeftButton />
            <h1 className="hidden flex-1 px-2 font-mono text-sm sm:block">
              <DatetimeDisplay />
            </h1>
            <TopRightHeaderContent />
          </header>
          <MainPanel />
          <CategoriesSheet />
        </main>
      </KeyboardProvider>
    </FeedProvider>
  );
}
