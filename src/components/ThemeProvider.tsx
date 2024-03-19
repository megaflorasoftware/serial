"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { type ThemeProviderProps } from "next-themes/dist/types";
import { api } from "~/trpc/react";
import { useUser } from "@clerk/nextjs";

const setVariable = (name: string, value: string) => {
  document.documentElement.style.setProperty(name, value);
};

function ApplyColorThemeOnMount() {
  const user = useUser();

  const { data } = api.userConfig.getConfig.useQuery(undefined, {
    enabled: user.isSignedIn ?? false,
  });

  React.useEffect(() => {
    if (!data) return;

    if (data.lightHSL) {
      const [hue, sat, lgt] = data.lightHSL;

      setVariable("--light-hue", `${hue}`);
      setVariable("--light-sat", `${sat}%`);
      setVariable("--light-lgt", `${lgt}%`);
    }

    if (data.darkHSL) {
      const [hue, sat, lgt] = data.darkHSL;
      setVariable("--dark-hue", `${hue}`);
      setVariable("--dark-sat", `${sat}%`);
      setVariable("--dark-lgt", `${lgt}%`);
    }
  }, [data]);

  return null;
}

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider {...props}>
      <React.Suspense>
        {children}
        <ApplyColorThemeOnMount />
      </React.Suspense>
    </NextThemesProvider>
  );
}
