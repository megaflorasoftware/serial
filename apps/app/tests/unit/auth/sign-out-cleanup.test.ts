import { describe, expect, it, vi } from "vitest";
import { clearUserDataAfterSignOut } from "~/lib/auth/sign-out-cleanup";

describe("clearUserDataAfterSignOut", () => {
  it("clears every account-specific browser store", () => {
    const clearQueryCache = vi.fn();
    const clearPersistedUserData = vi.fn();
    const clearNavigationCache = vi.fn();
    const clearLocalStorage = vi.fn();

    clearUserDataAfterSignOut({
      clearQueryCache,
      clearPersistedUserData,
      clearNavigationCache,
      localStorage: { clear: clearLocalStorage },
    });

    expect(clearQueryCache).toHaveBeenCalledOnce();
    expect(clearPersistedUserData).toHaveBeenCalledOnce();
    expect(clearNavigationCache).toHaveBeenCalledOnce();
    expect(clearLocalStorage).toHaveBeenCalledOnce();
  });
});
