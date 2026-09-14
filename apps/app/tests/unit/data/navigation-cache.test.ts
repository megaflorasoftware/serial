import { describe, expect, it, vi } from "vitest";
import {
  AUTH_NAVIGATION_PATTERN,
  classifyNavigationRevalidation,
  deleteNavigationCache,
  getCacheableNavigationResponse,
  getShellReloadUrl,
  NAVIGATION_CACHE_NAME,
  normalizeNavigationResponse,
} from "~/lib/pwa/navigation-cache";

const ROOT_URL = "https://app.example.com/";

function responseAt(url: string, init?: ResponseInit) {
  const response = new Response("shell", init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("service-worker navigation cache", () => {
  it("rejects a transient server error instead of replacing the shell", () => {
    const response = new Response("unavailable", { status: 503 });

    expect(getCacheableNavigationResponse(ROOT_URL, response)).toBeNull();
  });

  it("keeps successful same-path responses cacheable", () => {
    const response = responseAt(ROOT_URL, { status: 200 });

    expect(getCacheableNavigationResponse(ROOT_URL, response)).toBe(response);
  });

  it("keeps synthetic responses without a URL cacheable", () => {
    const response = new Response("shell", { status: 200 });

    expect(getCacheableNavigationResponse(ROOT_URL, response)).toBe(response);
  });

  it("rejects a response that resolved at the sign-in page", () => {
    const response = responseAt("https://app.example.com/auth/sign-in", {
      status: 200,
    });
    Object.defineProperty(response, "redirected", { value: true });

    expect(getCacheableNavigationResponse(ROOT_URL, response)).toBeNull();
  });

  it("removes redirected response metadata from a valid shell", () => {
    const response = new Response("shell", { status: 200 });
    Object.defineProperty(response, "redirected", { value: true });

    const normalized = normalizeNavigationResponse(response);

    expect(normalized).not.toBe(response);
    expect(normalized.redirected).toBe(false);
    expect(normalized.status).toBe(200);
  });

  describe("background revalidation", () => {
    it("caches a valid shell for the requested path", () => {
      const response = responseAt(ROOT_URL, { status: 200 });

      expect(classifyNavigationRevalidation(ROOT_URL, response)).toBe("cache");
    });

    it("keeps the stale shell when the server fails without redirecting", () => {
      const response = responseAt(ROOT_URL, { status: 503 });

      expect(classifyNavigationRevalidation(ROOT_URL, response)).toBe(
        "keep-stale",
      );
    });

    it("invalidates when the session ended and the server redirected", () => {
      const response = responseAt("https://app.example.com/auth/sign-in", {
        status: 200,
      });

      expect(classifyNavigationRevalidation(ROOT_URL, response)).toBe(
        "redirected",
      );
    });

    it("invalidates on an opaque redirect the worker cannot follow", () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, "type", { value: "opaqueredirect" });

      expect(classifyNavigationRevalidation(ROOT_URL, response)).toBe(
        "redirected",
      );
    });

    it("treats a redirect to another path as ended even when it failed", () => {
      const response = responseAt("https://app.example.com/maintenance", {
        status: 503,
      });

      expect(classifyNavigationRevalidation(ROOT_URL, response)).toBe(
        "redirected",
      );
    });
  });

  describe("authentication document routing", () => {
    it.each(["/auth", "/auth/sign-in", "/auth/sign-in?method=email"])(
      "never serves %s stale",
      (path) => {
        expect(AUTH_NAVIGATION_PATTERN.test(path)).toBe(true);
      },
    );

    it.each(["/", "/read/abc", "/authors", "/feeds?auth=1"])(
      "serves %s from the cached shell first",
      (path) => {
        expect(AUTH_NAVIGATION_PATTERN.test(path)).toBe(false);
      },
    );
  });

  describe("deleteNavigationCache", () => {
    it("drops the navigation cache", async () => {
      const del = vi.fn().mockResolvedValue(true);

      await expect(
        deleteNavigationCache({ delete: del } as unknown as CacheStorage),
      ).resolves.toBe(true);
      expect(del).toHaveBeenCalledWith(NAVIGATION_CACHE_NAME);
    });

    it("is a no-op where the Cache API is unavailable", async () => {
      await expect(deleteNavigationCache(undefined)).resolves.toBe(false);
    });
  });

  describe("getShellReloadUrl", () => {
    it("drops the fragment so the navigation leaves the document", () => {
      expect(getShellReloadUrl("https://app.example.com/read/abc#notes")).toBe(
        "https://app.example.com/read/abc",
      );
    });

    it("keeps the path and query of the served navigation", () => {
      expect(getShellReloadUrl("https://app.example.com/?tab=saved")).toBe(
        "https://app.example.com/?tab=saved",
      );
    });
  });
});
