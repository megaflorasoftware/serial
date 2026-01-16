import "~/styles/globals.css";

import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Suspense } from "react";
import { AppLeftSidebar, AppRightSidebar } from "~/components/app-sidebar";
// import { ApplyColorTheme } from "~/components/color-theme/ApplyColorTheme";
// import { ReleaseNotifier } from "~/components/releases/ReleaseNotifier";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { InitialClientQueries } from "~/lib/data/InitialClientQueries";
import { authMiddleware } from "~/server/auth";
import { AppDialogs } from "../_todo/feed/AppDialogs";
import { Header } from "../_todo/feed/Header";
import FeedLoading from "../components/loading";

export const Route = createFileRoute("/_app")({
  component: RootLayout,
  server: {
    middleware: [authMiddleware],
  },
});

function RootLayout() {
  return (
    // <ApplyColorTheme>
    <Suspense fallback={<FeedLoading />}>
      <InitialClientQueries>
        <SidebarProvider
          style={
            {
              "--sidebar-width": "calc(var(--spacing) * 72)",
              "--header-height": "calc(var(--spacing) * 12)",
            } as React.CSSProperties
          }
        >
          <AppLeftSidebar />
          <SidebarInset>
            <Header />
            <main className="flex flex-col">
              <div className="h-full w-full pb-6">
                <Outlet />
              </div>
              <AppDialogs />
            </main>
            {/*<ReleaseNotifier />*/}
          </SidebarInset>
          <AppRightSidebar />
        </SidebarProvider>
      </InitialClientQueries>
    </Suspense>
    // </ApplyColorTheme>
  );
}
