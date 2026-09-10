"use client";

// Content actions on the root route behave identically whether triggered by a
// keyboard shortcut or an item button. The mounted feed list registers its
// navigation handlers here; callers provide only their own mutation endpoint,
// so the advance/scroll behavior stays shared while endpoints differ.

type RootContentNavigation = {
  toggleReadWithAdvance: (contentId: string, toggleRead: () => boolean) => void;
  toggleSavedWithAdvance: (
    contentId: string,
    toggleSaved: () => boolean,
  ) => void;
  advanceAfterSendToInstapaper: (contentId: string) => void;
};

let rootContentNavigation: RootContentNavigation | null = null;

export function registerRootContentNavigation(
  navigation: RootContentNavigation,
) {
  rootContentNavigation = navigation;
  return () => {
    if (rootContentNavigation === navigation) {
      rootContentNavigation = null;
    }
  };
}

export function toggleContentRead(
  contentId: string,
  toggleRead: () => boolean,
) {
  if (!rootContentNavigation) {
    toggleRead();
    return;
  }
  rootContentNavigation.toggleReadWithAdvance(contentId, toggleRead);
}

export function toggleContentSaved(
  contentId: string,
  toggleSaved: () => boolean,
) {
  if (!rootContentNavigation) {
    toggleSaved();
    return;
  }
  rootContentNavigation.toggleSavedWithAdvance(contentId, toggleSaved);
}

export function advanceAfterSendToInstapaper(contentId: string) {
  rootContentNavigation?.advanceAfterSendToInstapaper(contentId);
}
