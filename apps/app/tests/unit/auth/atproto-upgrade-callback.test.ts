import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import type * as AtprotoConfig from "~/server/auth/atproto/config";
import type * as AtprotoService from "~/server/auth/atproto/service";
import type * as AuthApi from "better-auth/api";
import { atprotoConnections, user } from "~/server/db/schema";

const { dbHolder, finishAuth, revoke } = vi.hoisted(() => {
  const holder: { current: unknown } = { current: undefined };
  return { dbHolder: holder, finishAuth: vi.fn(), revoke: vi.fn() };
});
vi.mock("~/server/db", () => ({
  get db() {
    return dbHolder.current;
  },
}));
vi.mock("~/env", () => ({
  env: {
    PUBLIC_BASE_URL: "https://serial.test",
    BETTER_AUTH_SECRET: "test-secret",
    TRUSTED_ORIGINS: [],
  },
}));
vi.mock("~/server/auth/atproto/client", () => ({
  getAtprotoClient: () => Promise.resolve({ revoke }),
}));
vi.mock("~/server/auth/atproto/config", async (importOriginal) => ({
  ...(await importOriginal<typeof AtprotoConfig>()),
  validateAtprotoConfigAtStartup: vi.fn(),
}));
vi.mock("~/server/auth/atproto/service", async (importOriginal) => ({
  ...(await importOriginal<typeof AtprotoService>()),
  finishAtprotoAuth: finishAuth,
}));
vi.mock("better-auth/api", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthApi>()),
  getSessionFromCtx: () => Promise.resolve({ user: { id: "user-1" } }),
}));
vi.mock("~/server/logger", () => ({
  logError: vi.fn(),
  captureException: vi.fn(),
}));

const { atprotoPlugin } = await import("~/server/auth/atproto/plugin");
const DID = "did:plc:callback-cleanup";
type DatabaseSession = ReturnType<typeof openBenchmarkDatabase>;
type Target = ReturnType<typeof createLocalBenchmarkTarget>;

let session: DatabaseSession;
let target: Target;

beforeEach(async () => {
  target = createLocalBenchmarkTarget();
  session = openBenchmarkDatabase({ url: target.url });
  await applyMigrations(session.baseClient);
  dbHolder.current = session.database;
  revoke.mockResolvedValue(undefined);
  for (const id of ["user-1", "user-2"]) {
    await session.database.insert(user).values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  finishAuth.mockResolvedValue({
    did: DID,
    grantedScope: "atproto include:site.standard.authSocial",
    upgradeUserId: "user-1",
    pendingSyncSettingsVersion: 0,
    pendingSyncPreferences: { method: "export", importAsInactive: false },
  });
});

afterEach(() => {
  session.close();
  target.cleanup();
  dbHolder.current = undefined;
  vi.resetAllMocks();
});

async function callback() {
  return atprotoPlugin().endpoints.atprotoUpgradeCallback({
    request: new Request(
      "https://serial.test/api/auth/atproto/upgrade-callback?code=test",
    ),
    headers: new Headers(),
    context: {} as never,
  });
}

async function expectCallbackRedirect(result: string) {
  const error = (await callback().catch((err: unknown) => err)) as {
    status: string;
    headers: Headers;
  };
  expect(error).toMatchObject({ status: "FOUND" });
  expect(error.headers.get("location")).toBe(`/?atproto_consent=${result}`);
}

describe("upgrade callback failure cleanup", () => {
  it.each([null, "user-2"])(
    "cleans up only an unbound exchanged grant, owner=%s",
    async (owner) => {
      // The SDK exchanged the code after an unlink, or after another user bound the DID.
      await session.database.insert(atprotoConnections).values({
        did: DID,
        userId: owner,
        session: "new-session",
        status: "active",
        scopes: "atproto include:site.standard.authSocial",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await expectCallbackRedirect("state");
      const row = await session.database
        .select()
        .from(atprotoConnections)
        .where(eq(atprotoConnections.did, DID))
        .get();
      expect(row?.userId).toBe(owner);
      expect(row?.session).toBe(owner === null ? null : "new-session");
      expect(revoke).toHaveBeenCalledTimes(owner === null ? 1 : 0);
    },
  );

  it("returns the changed result while preserving a bound grant and newer settings", async () => {
    await session.database.insert(atprotoConnections).values({
      did: DID,
      userId: "user-1",
      session: "new-session",
      status: "active",
      scopes: "atproto include:site.standard.authSocial",
      importSubscriptions: true,
      syncSettingsVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expectCallbackRedirect("changed");
    const row = await session.database
      .select()
      .from(atprotoConnections)
      .where(eq(atprotoConnections.did, DID))
      .get();
    expect(row).toMatchObject({
      session: "new-session",
      importSubscriptions: true,
      exportSubscriptions: false,
      syncSettingsVersion: 1,
    });
    expect(revoke).not.toHaveBeenCalled();
  });
});
