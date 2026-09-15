import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import { account, atprotoConnections, user } from "~/server/db/schema";

/**
 * The add-on link boundary: completeAtprotoLink must attach a DID only to
 * the session user the flow was started for, never steal a DID from
 * another user, and never leave a half-linked state (an account row
 * without a bound connection) behind. unlinkAtprotoConnection must revoke
 * and release the connection so the DID can be linked again.
 */

const dbHolder = vi.hoisted(() => {
  const holder: { current: unknown } = { current: undefined };
  return holder;
});

const revokeMock = vi.hoisted(() => vi.fn());
const authorizeMock = vi.hoisted(() => vi.fn());

vi.mock("~/server/db", () => ({
  get db() {
    return dbHolder.current;
  },
}));

vi.mock("~/server/auth/atproto/client", () => ({
  getAtprotoClient: async () => ({
    revoke: revokeMock,
    authorize: authorizeMock,
  }),
}));

// startAtprotoLink derives its redirect URI from the public base URL.
vi.mock("~/env", () => ({
  env: {
    PUBLIC_BASE_URL: "https://serial.test",
    BETTER_AUTH_SECRET: "test-secret",
  },
}));

const {
  AtprotoLinkError,
  AtprotoUpgradeError,
  completeAtprotoLink,
  completeAtprotoUpgrade,
  revokeAtprotoConnectionIfUnbound,
  saveAtprotoSyncSettings,
  startAtprotoLink,
  unlinkAtprotoConnection,
  upgradeAtprotoAuth,
} = await import("~/server/auth/atproto/service");

type Session = ReturnType<typeof openBenchmarkDatabase>;
type Target = ReturnType<typeof createLocalBenchmarkTarget>;

const DID = "did:plc:linkme";
const OTHER_DID = "did:plc:other";

describe("atproto link and unlink", () => {
  let session: Session;
  let target: Target;

  beforeEach(async () => {
    target = createLocalBenchmarkTarget();
    session = openBenchmarkDatabase({ url: target.url });
    await applyMigrations(session.baseClient);
    dbHolder.current = session.database;
    revokeMock.mockReset();

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
    // The connection row the OAuth callback's session store already wrote.
    await session.database.insert(atprotoConnections).values({
      did: DID,
      session: "ciphertext",
      scopes: "atproto",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(() => {
    session.close();
    target.cleanup();
    dbHolder.current = undefined;
  });

  function insertAccountRow(id: string, userId: string, accountId: string) {
    return session.database.insert(account).values({
      id,
      accountId,
      providerId: "atproto",
      userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  function createAccountRow(id: string) {
    return async (data: {
      userId: string;
      providerId: string;
      accountId: string;
      scope: string;
    }) => {
      await session.database.insert(account).values({
        id,
        accountId: data.accountId,
        providerId: data.providerId,
        userId: data.userId,
        scope: data.scope,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return { id };
    };
  }

  async function accountRows() {
    return session.database.select().from(account).all();
  }

  async function connectionRow() {
    const rows = await session.database
      .select()
      .from(atprotoConnections)
      .where(eq(atprotoConnections.did, DID))
      .all();
    return rows[0];
  }

  it("links a DID to the session user: account row plus bound connection", async () => {
    await completeAtprotoLink({
      did: DID,
      grantedScope: "atproto",
      sessionUserId: "user-1",
      linkUserId: "user-1",
      createAccountRow: createAccountRow("acc-1"),
    });

    const rows = await accountRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerId: "atproto",
      accountId: DID,
      userId: "user-1",
    });
    expect((await connectionRow())?.userId).toBe("user-1");
  });

  it("rejects a callback whose stored state names a different user", async () => {
    const create = vi.fn();
    await expect(
      completeAtprotoLink({
        did: DID,
        grantedScope: "atproto",
        sessionUserId: "user-2",
        linkUserId: "user-1",
        createAccountRow: create,
      }),
    ).rejects.toMatchObject({ code: "state" });
    expect(create).not.toHaveBeenCalled();
    expect(await accountRows()).toHaveLength(0);
  });

  it("rejects a callback with no link state at all", async () => {
    await expect(
      completeAtprotoLink({
        did: DID,
        grantedScope: "atproto",
        sessionUserId: "user-1",
        linkUserId: null,
        createAccountRow: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(AtprotoLinkError);
  });

  it("refuses a DID already linked to another user", async () => {
    await insertAccountRow("acc-other", "user-2", DID);
    await expect(
      completeAtprotoLink({
        did: DID,
        grantedScope: "atproto",
        sessionUserId: "user-1",
        linkUserId: "user-1",
        createAccountRow: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a second DID for a user with one already linked", async () => {
    await insertAccountRow("acc-existing", "user-1", OTHER_DID);
    await expect(
      completeAtprotoLink({
        did: DID,
        grantedScope: "atproto",
        sessionUserId: "user-1",
        linkUserId: "user-1",
        createAccountRow: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "exists" });
  });

  it("re-linking the same DID does not create a second account row", async () => {
    await insertAccountRow("acc-1", "user-1", DID);
    const create = vi.fn();
    await completeAtprotoLink({
      did: DID,
      grantedScope: "atproto",
      sessionUserId: "user-1",
      linkUserId: "user-1",
      createAccountRow: create,
    });
    expect(create).not.toHaveBeenCalled();
    expect(await accountRows()).toHaveLength(1);
    expect((await connectionRow())?.userId).toBe("user-1");
  });

  it("removes the created account row when the connection bind loses a race", async () => {
    // The connection was bound to another user between callback and link.
    await session.database
      .update(atprotoConnections)
      .set({ userId: "user-2" })
      .where(eq(atprotoConnections.did, DID));

    await expect(
      completeAtprotoLink({
        did: DID,
        grantedScope: "atproto",
        sessionUserId: "user-1",
        linkUserId: "user-1",
        createAccountRow: createAccountRow("acc-1"),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    // No half-linked state: the just-created account row is gone.
    expect(await accountRows()).toHaveLength(0);
  });

  it("unlink revokes, destroys credentials, and releases the connection", async () => {
    await completeAtprotoLink({
      did: DID,
      grantedScope: "atproto",
      sessionUserId: "user-1",
      linkUserId: "user-1",
      createAccountRow: createAccountRow("acc-1"),
    });

    await unlinkAtprotoConnection("user-1");

    expect(revokeMock).toHaveBeenCalledWith(DID);
    const row = await connectionRow();
    // Credential material destroyed (restore(did) has nothing to load) and
    // the row released so the DID can be linked again later.
    expect(row?.session).toBeNull();
    expect(row?.status).toBe("disconnected");
    expect(row?.userId).toBeNull();
  });

  it("unlink still releases the connection when server-side revoke fails", async () => {
    await session.database
      .update(atprotoConnections)
      .set({ userId: "user-1" })
      .where(eq(atprotoConnections.did, DID));
    revokeMock.mockRejectedValueOnce(new Error("authorization server down"));

    await unlinkAtprotoConnection("user-1");

    const row = await connectionRow();
    expect(row?.session).toBeNull();
    expect(row?.userId).toBeNull();
  });

  it("unlink is a no-op for a user with no connection", async () => {
    await expect(unlinkAtprotoConnection("user-2")).resolves.toBeUndefined();
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("conditional revoke destroys an unbound connection's credentials", async () => {
    await revokeAtprotoConnectionIfUnbound(DID);
    expect(revokeMock).toHaveBeenCalledWith(DID);
    expect((await connectionRow())?.session).toBeNull();
  });

  it("conditional revoke leaves a bound connection alone", async () => {
    await session.database
      .update(atprotoConnections)
      .set({ userId: "user-2" })
      .where(eq(atprotoConnections.did, DID));

    await revokeAtprotoConnectionIfUnbound(DID);
    expect(revokeMock).not.toHaveBeenCalled();
    expect((await connectionRow())?.session).toBe("ciphertext");
  });

  it("starting a flow revokes stale unbound connections still holding credentials", async () => {
    // A link whose callback stored a session but never bound a user, now
    // past the auth-state TTL.
    await session.database
      .update(atprotoConnections)
      .set({ updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(atprotoConnections.did, DID));
    authorizeMock.mockResolvedValue(new URL("https://pds.example/authorize"));

    await startAtprotoLink({
      identifier: "user.example.com",
      userId: "user-1",
    });
    // The sweep is fire-and-forget; give it a beat.
    await vi.waitFor(() => expect(revokeMock).toHaveBeenCalledWith(DID));

    const row = await connectionRow();
    expect(row?.session).toBeNull();
    expect(row?.status).toBe("disconnected");
  });

  it("a fresh link is identity-only while a reconnect re-requests the previous grant", async () => {
    authorizeMock.mockResolvedValue(new URL("https://pds.example/authorize"));

    await startAtprotoLink({
      identifier: "user.example.com",
      userId: "user-1",
    });
    expect(authorizeMock).toHaveBeenLastCalledWith(
      "user.example.com",
      expect.objectContaining({ scope: "atproto" }),
    );

    await startAtprotoLink({
      identifier: "user.example.com",
      userId: "user-1",
      previousScope: "atproto include:site.standard.authSocial",
    });
    expect(authorizeMock).toHaveBeenLastCalledWith(
      "user.example.com",
      expect.objectContaining({
        scope: "atproto include:site.standard.authSocial",
      }),
    );
  });

  it("unlink resets the sync settings so a later link starts from None", async () => {
    await completeAtprotoLink({
      did: DID,
      grantedScope: "atproto",
      sessionUserId: "user-1",
      linkUserId: "user-1",
      createAccountRow: createAccountRow("acc-1"),
    });
    await saveAtprotoSyncSettings({
      userId: "user-1",
      did: DID,
      preferences: { method: "bidirectional", importAsInactive: true },
    });
    expect(await connectionRow()).toMatchObject({
      importSubscriptions: true,
      exportSubscriptions: true,
      importAsInactive: true,
    });

    await unlinkAtprotoConnection("user-1");

    expect(await connectionRow()).toMatchObject({
      userId: null,
      importSubscriptions: false,
      exportSubscriptions: false,
      importAsInactive: false,
    });
  });
});

describe("atproto consent upgrade", () => {
  let session: Session;
  let target: Target;

  beforeEach(async () => {
    target = createLocalBenchmarkTarget();
    session = openBenchmarkDatabase({ url: target.url });
    await applyMigrations(session.baseClient);
    dbHolder.current = session.database;
    authorizeMock.mockReset();

    await session.database.insert(user).values({
      id: "user-1",
      name: "user-1",
      email: "user-1@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await session.database.insert(atprotoConnections).values({
      did: DID,
      userId: "user-1",
      session: "ciphertext",
      scopes: "atproto",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // The sign-in account row a link or sign-in left behind, with the
    // identity-only grant it was created with.
    await session.database.insert(account).values({
      id: "acc-upgrade",
      accountId: DID,
      providerId: "atproto",
      userId: "user-1",
      scope: "atproto",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(() => {
    session.close();
    target.cleanup();
    dbHolder.current = undefined;
  });

  async function connectionRow() {
    return session.database
      .select()
      .from(atprotoConnections)
      .where(eq(atprotoConnections.did, DID))
      .get();
  }

  it("starts a consent flow on the upgrade redirect URI carrying the pending settings", async () => {
    authorizeMock.mockResolvedValue(new URL("https://pds.example/authorize"));

    await upgradeAtprotoAuth({
      did: DID,
      scope: "atproto include:site.standard.authSocial",
      userId: "user-1",
      pendingSyncPreferences: { method: "export", importAsInactive: false },
    });

    expect(authorizeMock).toHaveBeenCalledWith(DID, {
      scope: "atproto include:site.standard.authSocial",
      prompt: "consent",
      state: JSON.stringify({
        expectedDid: DID,
        upgradeUserId: "user-1",
        pendingSyncPreferences: { method: "export", importAsInactive: false },
      }),
      redirect_uri: "https://serial.test/api/auth/atproto/upgrade-callback",
    });
    // Nothing is saved until the callback.
    expect((await connectionRow())?.exportSubscriptions).toBe(false);
  });

  it("refuses a scope outside the allowlist", async () => {
    await expect(
      upgradeAtprotoAuth({
        did: DID,
        scope: "atproto repo:*",
        userId: "user-1",
        pendingSyncPreferences: { method: "export", importAsInactive: false },
      }),
    ).rejects.toThrow(/Disallowed/);
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it("saves the pending settings once consent comes back for the same user", async () => {
    const saved = await completeAtprotoUpgrade({
      did: DID,
      grantedScope: "atproto include:site.standard.authSocial",
      sessionUserId: "user-1",
      upgradeUserId: "user-1",
      pendingSyncPreferences: {
        method: "bidirectional",
        importAsInactive: true,
      },
    });

    expect(saved).toEqual({ method: "bidirectional", importAsInactive: true });
    expect(await connectionRow()).toMatchObject({
      importSubscriptions: true,
      exportSubscriptions: true,
      importAsInactive: true,
    });
    // The sign-in account row records the broader grant too, so a later
    // reconnect that finds only that row re-requests the same scope.
    const accountRow = await session.database
      .select({ scope: account.scope })
      .from(account)
      .where(eq(account.accountId, DID))
      .get();
    expect(accountRow?.scope).toBe("atproto include:site.standard.authSocial");
  });

  it("rejects a callback whose state names a different user and saves nothing", async () => {
    await expect(
      completeAtprotoUpgrade({
        did: DID,
        grantedScope: "atproto include:site.standard.authSocial",
        sessionUserId: "user-2",
        upgradeUserId: "user-1",
        pendingSyncPreferences: { method: "export", importAsInactive: false },
      }),
    ).rejects.toMatchObject({ code: "state" });
    expect((await connectionRow())?.exportSubscriptions).toBe(false);
  });

  it("rejects a callback that carried no pending settings", async () => {
    await expect(
      completeAtprotoUpgrade({
        did: DID,
        grantedScope: "atproto include:site.standard.authSocial",
        sessionUserId: "user-1",
        upgradeUserId: "user-1",
        pendingSyncPreferences: null,
      }),
    ).rejects.toBeInstanceOf(AtprotoUpgradeError);
  });

  it("saving settings reports no match for a DID the user does not hold", async () => {
    await expect(
      saveAtprotoSyncSettings({
        userId: "user-1",
        did: OTHER_DID,
        preferences: { method: "import", importAsInactive: false },
      }),
    ).resolves.toBe(false);
    expect((await connectionRow())?.importSubscriptions).toBe(false);
  });

  it("rejects a callback for a DID that is not the session user's connection", async () => {
    await expect(
      completeAtprotoUpgrade({
        did: OTHER_DID,
        grantedScope: "atproto include:site.standard.authSocial",
        sessionUserId: "user-1",
        upgradeUserId: "user-1",
        pendingSyncPreferences: { method: "export", importAsInactive: false },
      }),
    ).rejects.toMatchObject({ code: "state" });
    expect((await connectionRow())?.exportSubscriptions).toBe(false);
  });
});
