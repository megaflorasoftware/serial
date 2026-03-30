"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ArticleFontFamily } from "~/lib/constants/article-fonts";
import { orpc } from "~/lib/orpc";
import { FONT_FAMILY_CSS } from "~/lib/constants/article-fonts";

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

    const fontFamilyKey = (data.articleFontFamily ??
      "sans-serif") as ArticleFontFamily;
    root.style.setProperty(
      "--article-font-family",
      FONT_FAMILY_CSS[fontFamilyKey] ?? FONT_FAMILY_CSS["sans-serif"],
    );
  }, [data]);

  return null;
}
