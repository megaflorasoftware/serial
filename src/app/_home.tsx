import "~/styles/globals.css";

import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { Suspense } from "react";
import { AppLeftSidebar, AppRightSidebar } from "~/components/app-sidebar";
import { ApplyColorTheme } from "~/components/color-theme/ApplyColorTheme";
import { ReleaseNotifier } from "~/components/releases/ReleaseNotifier";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { InitialClientQueries } from "~/lib/data/InitialClientQueries";
import { fetchIsAuthed } from "~/server/auth";
import { AppDialogs } from "../_todo/feed/AppDialogs";
import { Header } from "../_todo/feed/Header";
import FeedLoading from "../components/loading";

const title = "Serial";
const description = "Your personal content newsletter";

// export const metadata: Metadata = {
//   title: title,
//   applicationName: title,
//   appleWebApp: {
//     capable: true,
//     title: title,
//     startupImage: "/apple-touch-icon.png",
//     statusBarStyle: "default",
//   },
//   description: description,
//   formatDetection: {
//     telephone: false,
//   },
//   generator: "Next.js",
//   manifest: "/app.webmanifest",
//   keywords: ["video", "rss", "newsletter", "content", "youtube", "podcast"],
//   authors: [
//     {
//       name: "Henry Fellerhoff",
//       url: "https://www.henryfellerhoff.com",
//     },
//   ],
//   icons: [
//     { rel: "icon", url: "/favicon.ico" },
//     {
//       rel: "icon",
//       sizes: "16x16",
//       type: "image/png",
//       url: "/favicon-16x16.png",
//     },
//     {
//       rel: "icon",
//       sizes: "32x32",
//       type: "image/png",
//       url: "/favicon-32x32.png",
//     },
//     { rel: "apple-touch-icon", sizes: "180x180", url: "/apple-touch-icon.png" },
//     {
//       rel: "icon",
//       type: "image/png",
//       sizes: "512x512",
//       url: "/android-chrome-512x512.png",
//     },
//   ],
//   twitter: {
//     card: "summary",
//     creator: "@henryfellerhoff",
//     title: title,
//     description: description,
//   },
//   openGraph: {
//     title: title,
//     description: description,
//     type: "website",
//     images: [
//       {
//         url: "/icon-256.png",
//         width: 256,
//         height: 256,
//         alt: title,
//       },
//     ],
//   },
// };

// export const viewport: Viewport = {
//   themeColor: [
//     { color: "hsl(20 14.3% 4.1%)" },
//     // { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
//     // { media: "(prefers-color-scheme: dark)", color: "hsl(20 14.3% 4.1%)" },
//   ],
// };

export const Route = createFileRoute("/_home")({
  component: RootLayout,
  beforeLoad: async (params) => {
    if (!(await fetchIsAuthed())) {
      throw redirect({
        to: "/auth",
      });
    }
  },
});

function RootLayout() {
  return (
    <ApplyColorTheme>
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
              <ReleaseNotifier />
            </SidebarInset>
            <AppRightSidebar />
          </SidebarProvider>
        </InitialClientQueries>
      </Suspense>
    </ApplyColorTheme>
  );
}
