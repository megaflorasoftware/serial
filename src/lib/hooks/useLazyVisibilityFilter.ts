"use client";

/**
 * Hook that was previously used to lazy-load items when visibility filter changed.
 * With the new diff-based initial data loading, all visibility filters (unread,
 * read, later) are sent during the initial requestInitialData flow, so this
 * hook is now a no-op kept for backward compatibility.
 */
export function useLazyVisibilityFilter() {
  // All visibility filters are now diffed and sent during initial load.
  // No lazy loading needed.
}
