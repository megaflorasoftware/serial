import "~/styles/globals.css";

import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";

import { TRPCReactProvider } from "~/trpc/react";
import { cn } from "~/lib/utils";
import { ThemeProvider } from "~/components/ThemeProvider";
import { type Viewport } from "next";
import { Toaster } from "sonner";
import { KeyboardProvider } from "~/components/KeyboardProvider";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

export const metadata = {
  title: "Serial",
  description: "Your personal content newsletter",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "white" },
    { media: "(prefers-color-scheme: dark)", color: "black" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="en" suppressHydrationWarning>
        <body
          className={cn(`min-h-screen font-sans antialiased ${inter.variable}`)}
        >
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            <TRPCReactProvider>
              <KeyboardProvider>{children}</KeyboardProvider>
              <Toaster />
            </TRPCReactProvider>
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
