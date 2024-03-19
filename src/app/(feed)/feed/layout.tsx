import "~/styles/globals.css";

import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";

import { TRPCReactProvider } from "~/trpc/react";
import { cn } from "~/lib/utils";
import { ThemeProvider } from "~/components/ThemeProvider";
import { type Metadata, type Viewport } from "next";
import { Toaster } from "sonner";
import { FeedProvider } from "~/components/FeedProvider";
import { KeyboardProvider } from "~/components/KeyboardProvider";
import { Header } from "../Header";
import { ScrollArea } from "~/components/ui/scroll-area";
import { AppDialogs } from "../AppDialogs";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

const title = "Serial";
const description = "Your personal content newsletter";

export const metadata: Metadata = {
  title: title,
  applicationName: title,
  appleWebApp: {
    capable: true,
    title: title,
    startupImage: "/apple-touch-icon.png",
    statusBarStyle: "default",
  },
  description: description,
  formatDetection: {
    telephone: false,
  },
  generator: "Next.js",
  manifest: "/manifest.json",
  keywords: ["video", "rss", "newsletter", "content", "youtube", "podcast"],
  authors: [
    {
      name: "Henry Fellerhoff",
      url: "https://www.henryfellerhoff.com",
    },
  ],
  icons: [
    { rel: "icon", url: "/favicon.ico" },
    {
      rel: "icon",
      sizes: "16x16",
      type: "image/png",
      url: "/favicon-16x16.png",
    },
    {
      rel: "icon",
      sizes: "32x32",
      type: "image/png",
      url: "/favicon-32x32.png",
    },
    { rel: "apple-touch-icon", sizes: "180x180", url: "/apple-touch-icon.png" },
    {
      rel: "icon",
      type: "image/png",
      sizes: "512x512",
      url: "/android-chrome-512x512.png",
    },
  ],
  twitter: {
    card: "summary",
    creator: "@henryfellerhoff",
    title: title,
    description: description,
  },
  openGraph: {
    title: title,
    description: description,
    type: "website",
    images: [
      {
        url: "/icon-256.png",
        width: 256,
        height: 256,
        alt: title,
      },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { color: "hsl(20 14.3% 4.1%)" },
    // { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
    // { media: "(prefers-color-scheme: dark)", color: "hsl(20 14.3% 4.1%)" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <FeedProvider>
      <KeyboardProvider>
        <main className="flex h-screen flex-col">
          <Header />
          <ScrollArea className="h-full w-full">
            <div className="h-full w-full pb-6 pt-24">{children}</div>
          </ScrollArea>
          <AppDialogs />
        </main>
      </KeyboardProvider>
    </FeedProvider>
  );
}
