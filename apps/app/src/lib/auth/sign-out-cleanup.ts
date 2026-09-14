type SignOutCleanupOptions = {
  clearQueryCache: () => void;
  clearPersistedUserData: () => void;
  /**
   * The cached application shell was rendered for the signed-out session.
   * Dropping it makes the next launch reach the server and land on sign-in
   * instead of booting the stale shell first.
   */
  clearNavigationCache: () => void;
  localStorage: Pick<Storage, "clear">;
};

export function clearUserDataAfterSignOut({
  clearQueryCache,
  clearPersistedUserData,
  clearNavigationCache,
  localStorage,
}: SignOutCleanupOptions) {
  clearQueryCache();
  clearPersistedUserData();
  clearNavigationCache();
  localStorage.clear();
}
