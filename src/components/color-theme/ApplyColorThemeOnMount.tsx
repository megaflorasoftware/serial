"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "~/lib/orpc";

const FONT_FAMILY_MAP: Record<string, string> = {
  "sans-serif": '"Outfit Variable", sans-serif',
  serif: '"Noto Serif Variable", serif',
};

export function ApplyUserConfig() {
  const { data } = useQuery(orpc.userConfig.getConfig.queryOptions());

  useEffect(() => {
    if (!data) return;

    const root = document.documentElement;

    if (data.lightHSL) {
      const [hue, sat, lgt] = data.lightHSL;
      root.style.setProperty("--light-hue", `${hue}`);
      root.style.setProperty("--light-sat", `${sat}%`);
      root.style.setProperty("--light-lgt", `${lgt}%`);
    }

    if (data.darkHSL) {
      const [hue, sat, lgt] = data.darkHSL;
      root.style.setProperty("--dark-hue", `${hue}`);
      root.style.setProperty("--dark-sat", `${sat}%`);
      root.style.setProperty("--dark-lgt", `${lgt}%`);
    }

    if (data.articleFontSize) {
      root.style.setProperty("--article-font-size", `${data.articleFontSize}`);
    }

    const fontFamilyKey = data.articleFontFamily ?? "sans-serif";
    root.style.setProperty(
      "--article-font-family",
      FONT_FAMILY_MAP[fontFamilyKey] ?? fontFamilyKey,
    );
  }, [data]);

  return null;
}
