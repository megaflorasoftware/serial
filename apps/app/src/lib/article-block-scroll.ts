"use client";

import { getScrollContainer } from "~/lib/scroll";

/** Every block lands with its top edge one-sixth down the viewport. */
export const ARTICLE_BLOCK_SCROLL = {
  viewportPosition: 1 / 6,
} as const;

export function getArticleBlockTargetScrollTop(
  element: HTMLElement,
  container: HTMLElement = getScrollContainer(),
) {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();

  return (
    container.scrollTop +
    (elementRect.top - containerRect.top) -
    containerRect.height * ARTICLE_BLOCK_SCROLL.viewportPosition
  );
}

export function scrollArticleBlockToTarget(
  element: HTMLElement,
  behavior: ScrollBehavior,
  container: HTMLElement = getScrollContainer(),
) {
  container.scrollTo({
    top: getArticleBlockTargetScrollTop(element, container),
    behavior,
  });
}

export function setArticleRestorationVisibility(
  element: HTMLElement,
  visible: boolean,
) {
  element.style.visibility = visible ? "" : "hidden";
}
