import { ThemeProvider } from "~/components/ThemeProvider";
import { Toaster } from "~/components/ui/sonner";
import { TRPCReactProvider } from "~/trpc/react";

import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { ApplyColorThemeOnServerMount } from "~/components/color-theme/ApplyColorThemeOnMount";
import { orpcRouterClient } from "~/lib/orpc";
import { fetchIsAuthed } from "~/server/auth";
import appCss from "~/styles/globals.css?url";

// const inter = Inter({
//   subsets: ["latin"],
//   variable: "--font-sans",
// });

// const title = "Serial";
// const description =
//   "A snappy, customizable video feed. Designed to show you exactly the content you want to see and nothing else.";

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
//         url: "/masonry-preview.png",
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

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      { title: "TanStack Start Starter" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  component: RootLayout,
  loader: async () => {
    const isAuthed = fetchIsAuthed();

    if (!isAuthed) {
      return {
        variables: null,
      };
    }

    const data = await orpcRouterClient.userConfig.getConfig();

    return {
      variables: data,
    };
  },
});

export function RootLayout() {
  const data = Route.useLoaderData();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* {process.env.NODE_ENV !== "production" && (
          <>
            <script
              crossOrigin="anonymous"
              src="//unpkg.com/react-scan/dist/auto.global.js"
            />
          </>
        )} */}
        {process.env.NODE_ENV === "production" && (
          <>
            <script
              async
              defer
              data-website-id="b65ad781-e11e-43e3-a53e-35e09c16709a"
              src="https://umami.henryfellerhoff.com/script.js"
            />
          </>
        )}
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        />
      </head>
      <body
        // className={cn(`min-h-screen font-sans antialiased ${inter.variable}`)}
        className="min-h-screen font-sans antialiased"
      >
        <ApplyColorThemeOnServerMount data={data.variables} />
        <TRPCReactProvider>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            <Outlet />
            <Scripts />
            <Toaster />
          </ThemeProvider>
        </TRPCReactProvider>
      </body>
    </html>
  );
}
