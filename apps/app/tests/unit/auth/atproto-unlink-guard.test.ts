import { createRouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import type { ORPCContext } from "~/server/orpc/base";
import {
  account,
  appConfig,
  atprotoConnections,
  user,
} from "~/server/db/schema";

/**
 * The ConnectionsDialog procedures: unlink must refuse to remove the
 * user's sole sign-in method, and a second link attempt while connected is
 * rejected before any OAuth round trip starts.
 */

const testState = vi.hoisted(
  (): { database: unknown; oauthConfigured: boolean } => ({
    database: undefined,
    oauthConfigured: false,
  }),
);

const revokeMock = vi.hoisted(() => vi.fn());
const authorizeMock = vi.hoisted(() => vi.fn());

vi.mock("~/server/db", () => ({
  get db() {
    return testState.database;
  },
}));
vi.mock("~/server/auth", () => ({ auth: {} }));
vi.mock("~/server/auth/constants", () => ({
  isAtprotoConfigured: () => true,
  isOAuthConfigured: () => testState.oauthConfigured,
}));
vi.mock("~/server/auth/atproto/client", () => ({
  getAtprotoClient: async () => ({
    revoke: revokeMock,
    authorize: authorizeMock,
  }),
}));
vi.mock("~/env", () => ({
  env: {
    OAUTH_PROVIDER_ID: "oidc",
    PUBLIC_BASE_URL: "https://serial.test",
  },
}));

const atprotoRouter = await import("~/server/api/routers/atprotoRouter");

type Session = ReturnType<typeof openBenchmarkDatabase>;
type Target = ReturnType<typeof createLocalBenchmarkTarget>;

const DID = "did:plc:guarded";

describe("atproto connection procedures", () => {
  let session: Session;
  let target: Target;

  beforeEach(async () => {
    target = createLocalBenchmarkTarget();
    session = openBenchmarkDatabase({ url: target.url });
    await applyMigrations(session.baseClient);
    testState.database = session.database;
    testState.oauthConfigured = false;
    revokeMock.mockReset();
    authorizeMock.mockReset();

    await session.database.insert(user).values({
      id: "user-1",
      name: "user-1",
      email: "user-1@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(() => {
    session.close();
    target.cleanup();
    testState.database = undefined;
  });

  function api() {
    return createRouterClient(
      { atproto: atprotoRouter },
      {
        context: {
          headers: new Headers(),
          session: { id: "session-1" },
          user: { id: "user-1" },
          db: session.database,
        } as unknown as ORPCContext,
      },
    );
  }

  async function seedLinked(options?: {
    extraProviderId?: string;
    scopes?: string;
  }) {
    await session.database.insert(account).values({
      id: "acc-atproto",
      accountId: DID,
      providerId: "atproto",
      userId: "user-1",
      scope: options?.scopes ?? "atproto",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    if (options?.extraProviderId) {
      await session.database.insert(account).values({
        id: "acc-extra",
        accountId: "extra-account",
        providerId: options.extraProviderId,
        userId: "user-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    await session.database.insert(atprotoConnections).values({
      did: DID,
      userId: "user-1",
      session: "ciphertext",
      scopes: options?.scopes ?? "atproto",
      handle: "guarded.example.com",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function setEnabledSigninProviders(providers: string[]) {
    await session.database
      .insert(appConfig)
      .values({
        key: "enabled-signin-providers",
        value: JSON.stringify(providers),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: appConfig.key,
        set: { value: JSON.stringify(providers), updatedAt: new Date() },
      });
  }

  async function atprotoAccountRows() {
    return session.database
      .select()
      .from(account)
      .where(eq(account.providerId, "atproto"))
      .all();
  }

  it("reports the connected handle", async () => {
    await seedLinked({ extraProviderId: "credential" });
    const status = await api().atproto.getConnectionStatus();
    expect(status).toEqual({
      isConnected: true,
      needsReconnect: false,
      handle: "guarded.example.com",
      isConfigured: true,
      hasWriteScope: false,
      syncPreferences: { method: "none", importAsInactive: false },
    });
  });

  it("surfaces a bound connection whose credentials were destroyed as reconnectable", async () => {
    await seedLinked({ extraProviderId: "credential" });
    await session.database
      .update(atprotoConnections)
      .set({ session: null, status: "disconnected" })
      .where(eq(atprotoConnections.did, DID));

    const status = await api().atproto.getConnectionStatus();
    expect(status).toEqual({
      isConnected: false,
      needsReconnect: true,
      handle: "guarded.example.com",
      isConfigured: true,
      hasWriteScope: false,
      syncPreferences: { method: "none", importAsInactive: false },
    });

    // The sign-in method still exists, so disconnect must work from here.
    await api().atproto.unlinkAccount();
    expect(await atprotoAccountRows()).toHaveLength(0);
    const after = await api().atproto.getConnectionStatus();
    expect(after.needsReconnect).toBe(false);
  });

  it("refuses to unlink the sole sign-in method", async () => {
    await seedLinked();
    await expect(api().atproto.unlinkAccount()).rejects.toThrow(
      /only way to sign in/,
    );
    expect(await atprotoAccountRows()).toHaveLength(1);
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("unlinks when a password credential remains", async () => {
    await seedLinked({ extraProviderId: "credential" });
    await api().atproto.unlinkAccount();

    expect(revokeMock).toHaveBeenCalledWith(DID);
    expect(await atprotoAccountRows()).toHaveLength(0);
    const status = await api().atproto.getConnectionStatus();
    expect(status.isConnected).toBe(false);
  });

  it("counts a generic OAuth account only while that provider is configured", async () => {
    await seedLinked({ extraProviderId: "oidc" });
    await setEnabledSigninProviders(["email", "oauth", "atproto"]);

    // Provider env has since been removed: the OAuth row is unusable.
    testState.oauthConfigured = false;
    await expect(api().atproto.unlinkAccount()).rejects.toThrow(
      /only way to sign in/,
    );

    testState.oauthConfigured = true;
    await api().atproto.unlinkAccount();
    expect(await atprotoAccountRows()).toHaveLength(0);
  });

  it("counts a credential account only while email sign-in is enabled", async () => {
    await seedLinked({ extraProviderId: "credential" });
    // The admin narrowed sign-in to atproto only: the credential row is no
    // way back in, so unlinking would lock this user out.
    await setEnabledSigninProviders(["atproto"]);
    await expect(api().atproto.unlinkAccount()).rejects.toThrow(
      /only way to sign in/,
    );

    await setEnabledSigninProviders(["email", "atproto"]);
    await api().atproto.unlinkAccount();
    expect(await atprotoAccountRows()).toHaveLength(0);
  });

  it("rejects starting a link while already connected", async () => {
    await seedLinked({ extraProviderId: "credential" });
    await expect(
      api().atproto.linkAccount({ identifier: "someone.example.com" }),
    ).rejects.toThrow(/already have an Atmosphere account/);
  });

  async function loseCredentials() {
    await session.database
      .update(atprotoConnections)
      .set({ session: null, status: "disconnected" })
      .where(eq(atprotoConnections.did, DID));
  }

  it.each([
    ["an identity-only grant", "atproto"],
    ["the social grant", "atproto include:site.standard.authSocial"],
  ])(
    "a reconnect re-requests %s exactly, on the link callback",
    async (_label, scopes) => {
      await seedLinked({ extraProviderId: "credential", scopes });
      await loseCredentials();
      authorizeMock.mockResolvedValue(new URL("https://pds.example/authorize"));

      await api().atproto.reconnectAccount();

      expect(authorizeMock).toHaveBeenCalledWith(DID, {
        scope: scopes,
        state: JSON.stringify({ linkUserId: "user-1" }),
        redirect_uri: "https://serial.test/api/auth/atproto/link-callback",
      });
    },
  );

  it.each([
    "atproto include:site.standard.authSocial",
    "repo?collection=site.standard.graph.recommend&collection=site.standard.graph.subscription atproto",
  ])("a reconnect recovers the account's grant: %s", async (scopes) => {
    await seedLinked({
      extraProviderId: "credential",
      scopes,
    });
    // The connection row was swept after its credentials were lost; the
    // sign-in account row still names the DID and its granted scope.
    await session.database
      .delete(atprotoConnections)
      .where(eq(atprotoConnections.did, DID));
    authorizeMock.mockResolvedValue(new URL("https://pds.example/authorize"));

    await api().atproto.reconnectAccount();

    expect(authorizeMock).toHaveBeenCalledWith(
      DID,
      expect.objectContaining({
        scope: "atproto include:site.standard.authSocial",
      }),
    );
  });

  it("a reconnect is refused while the connection is healthy or absent", async () => {
    await expect(api().atproto.reconnectAccount()).rejects.toThrow(
      /no Atmosphere account to reconnect/,
    );
    await seedLinked({ extraProviderId: "credential" });
    await expect(api().atproto.reconnectAccount()).rejects.toThrow(
      /already connected/,
    );
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it("a downgrade away from a write method saves directly", async () => {
    await seedLinked({
      extraProviderId: "credential",
      scopes: "atproto include:site.standard.authSocial",
    });
    await api().atproto.saveSyncSettings({
      method: "bidirectional",
      importAsInactive: false,
    });

    const result = await api().atproto.saveSyncSettings({
      method: "import",
      importAsInactive: false,
    });

    expect(result).toEqual({ saved: true, consentUrl: null });
    expect(await api().atproto.getConnectionStatus()).toMatchObject({
      hasWriteScope: true,
      syncPreferences: { method: "import", importAsInactive: false },
    });
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it("saves settings directly when the grant covers them", async () => {
    await seedLinked({ extraProviderId: "credential" });

    const importOnly = await api().atproto.saveSyncSettings({
      method: "import",
      importAsInactive: true,
    });
    expect(importOnly).toEqual({ saved: true, consentUrl: null });
    expect((await api().atproto.getConnectionStatus()).syncPreferences).toEqual(
      { method: "import", importAsInactive: true },
    );

    await session.database
      .update(atprotoConnections)
      .set({ scopes: "atproto include:site.standard.authSocial" })
      .where(eq(atprotoConnections.did, DID));
    const exporting = await api().atproto.saveSyncSettings({
      method: "bidirectional",
      importAsInactive: false,
    });
    expect(exporting).toEqual({ saved: true, consentUrl: null });
    expect(await api().atproto.getConnectionStatus()).toMatchObject({
      hasWriteScope: true,
      syncPreferences: { method: "bidirectional", importAsInactive: false },
    });
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it("saves a write method without consent for an expanded PDS grant", async () => {
    await seedLinked({
      extraProviderId: "credential",
      scopes:
        "repo?collection=site.standard.graph.recommend&collection=site.standard.graph.subscription atproto",
    });
    expect(await api().atproto.getConnectionStatus()).toMatchObject({
      hasWriteScope: true,
    });
    expect(
      await api().atproto.saveSyncSettings({
        method: "bidirectional",
        importAsInactive: false,
      }),
    ).toEqual({ saved: true, consentUrl: null });
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it("returns a consent URL instead of saving a write method the grant lacks", async () => {
    await seedLinked({ extraProviderId: "credential" });
    authorizeMock.mockResolvedValue(new URL("https://pds.example/consent"));

    const result = await api().atproto.saveSyncSettings({
      method: "export",
      importAsInactive: true,
    });

    expect(result).toEqual({
      saved: false,
      consentUrl: "https://pds.example/consent",
    });
    expect(authorizeMock).toHaveBeenCalledWith(
      DID,
      expect.objectContaining({
        scope: "atproto include:site.standard.authSocial",
        prompt: "consent",
        state: JSON.stringify({
          expectedDid: DID,
          upgradeUserId: "user-1",
          pendingSyncPreferences: { method: "export", importAsInactive: true },
          pendingSyncSettingsVersion: 0,
        }),
      }),
    );
    // Nothing saved: the inactive flag rides in the state, not the row.
    expect((await api().atproto.getConnectionStatus()).syncPreferences).toEqual(
      { method: "none", importAsInactive: false },
    );
  });

  it("refuses to save settings without an active connection", async () => {
    await seedLinked({ extraProviderId: "credential" });
    await session.database
      .update(atprotoConnections)
      .set({ session: null, status: "disconnected" })
      .where(eq(atprotoConnections.did, DID));

    await expect(
      api().atproto.saveSyncSettings({
        method: "import",
        importAsInactive: false,
      }),
    ).rejects.toThrow(/Connect your Atmosphere account/);
  });
});
