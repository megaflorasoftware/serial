import { UserButton } from "@clerk/nextjs";
import { unstable_noStore as noStore } from "next/cache";
import { AddFeedButton } from "~/components/AddFeedButton";
import { ColorModeToggle } from "~/components/ColorModeToggle";
import { DatetimeDisplay } from "~/components/DatetimeDisplay";

import { api } from "~/trpc/server";
import TodayItems from "./TodayItems";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "~/components/ui/resizable";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Suspense } from "react";
import { FeedProvider } from "~/components/FeedProvider";
import MainPanel from "./MainPanel";

export default async function Home() {
  noStore();
  const feeds = await api.feed.getAllFeedData.query();

  if (!feeds) return null;

  return (
    <FeedProvider feeds={feeds}>
      <main className="flex h-screen flex-col">
        <header className="sticky top-0 z-20 flex h-16 w-full items-center justify-between border-b bg-background px-6">
          <div className="h-8 w-8">
            <UserButton />
          </div>
          <h1 className="font-mono text-sm">
            <DatetimeDisplay />
          </h1>
          <div className="flex items-center gap-2">
            <AddFeedButton />
            <ColorModeToggle />
          </div>
        </header>
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel minSize={10} defaultSize={30}>
            <Suspense>
              <ScrollArea className="flex h-full w-full flex-col items-center justify-center gap-12">
                {feeds && <TodayItems />}
              </ScrollArea>
            </Suspense>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>
            <MainPanel />
          </ResizablePanel>
          {/* <ResizableHandle /> */}
          {/* <ResizablePanel defaultSize={20}></ResizablePanel> */}
        </ResizablePanelGroup>
      </main>
    </FeedProvider>
  );
}
