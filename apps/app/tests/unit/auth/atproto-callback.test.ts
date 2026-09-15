import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import { atprotoConnections } from "~/server/db/schema";

/**
 * The callback leg. The SDK owns validating state, exchanging the code, and
 * verifying the DID → PDS → authorization-server chain, so these cover what
 * happens around it: a rejected callback must surface and persist nothing,
 * and an upgrade flow that comes back for a different subject must destroy
 * the session the SDK just stored rather than complete.
 */

const dbHolder = vi.hoisted(() => {
  const holder: { current: unknown } = { current: undefined };
  return holder;
});

const clientHolder = vi.hoisted(() => {
  const holder: { current: unknown } = { current: undefined };
  return holder;
});

vi.mock("~/server/db", () => ({
  get db() {
    return dbHolder.current;
  },
}));

vi.mock("~/server/auth/atproto/client", () => ({
  getAtprotoClient: () => Promise.resolve(clientHolder.current),
}));

const {
  finishAtprotoAuth,
  resolveAndStoreAtprotoHandle,
  revokeAtprotoConnection,
  startAtprotoAuth,
} = await import("~/server/auth/atproto/service");

type Session = ReturnType<typeof openBenchmarkDatabase>;
type Target = ReturnType<typeof createLocalBenchmarkTarget>;

const DID = "did:plc:callbackuser";
const OTHER_DID = "did:plc:someoneelse";

const EXTENSION_CONNECT_RETURN_TO = `/auth/connect-extension?${new URLSearchParams(
  {
    redirect_uri:
      "https://olpaonddchkbjpmjjfamplfaibopllam.chromiumapp.org/serial-auth",
    state: "s".repeat(43),
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
  },
).toString()}`;

function oauthSession(did: string) {
  return {
    did,
    signOut: vi.fn().mockResolvedValue(undefined),
    getTokenInfo: vi.fn().mockResolvedValue({ scope: "atproto" }),
  };
}

function fakeClient(options: {
  callback?: () => Promise<unknown>;
  authorize?: () => Promise<URL>;
  handle?: string;
  resolveError?: Error;
}) {
  return {
    callback: options.callback ?? vi.fn(),
    authorize: options.authorize ?? vi.fn(),
    oauthResolver: {
      resolveIdentity: options.resolveError
        ? vi.fn().mockRejectedValue(options.resolveError)
        : vi.fn().mockResolvedValue({ handle: options.handle ?? "user.bsky" }),
    },
  };
}

describe("finishAtprotoAuth", () => {
  let session: Session;
  let target: Target;

  beforeEach(async () => {
    target = createLocalBenchmarkTarget();
    session = openBenchmarkDatabase({ url: target.url });
    await applyMigrations(session.baseClient);
    dbHolder.current = session.database;

    // The session store has already persisted the connection by the time
    // the SDK's callback resolves.
    await session.database.insert(atprotoConnections).values({
      did: DID,
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
    clientHolder.current = undefined;
  });

  async function connectionRow() {
    const rows = await session.database.select().from(atprotoConnections).all();
    return rows[0];
  }

  it("returns the verified DID, handle, and granted scope", async () => {
    const oauth = oauthSession(DID);
    clientHolder.current = fakeClient({
      callback: vi.fn().mockResolvedValue({ session: oauth, state: null }),
      handle: "reader.bsky.social",
    });

    const result = await finishAtprotoAuth(new URLSearchParams("code=abc"));

    expect(result.did).toBe(DID);
    expect(result.handle).toBe("reader.bsky.social");
    expect(result.grantedScope).toBe("atproto");
    expect(result.linkUserId).toBeNull();
    expect(result.returnTo).toBeNull();
    expect((await connectionRow())?.handle).toBe("reader.bsky.social");
  });

  it("returns the extension connect destination carried by the sign-in state", async () => {
    const oauth = oauthSession(DID);
    clientHolder.current = fakeClient({
      callback: vi.fn().mockResolvedValue({
        session: oauth,
        state: JSON.stringify({ returnTo: EXTENSION_CONNECT_RETURN_TO }),
      }),
    });

    const result = await finishAtprotoAuth(new URLSearchParams("code=abc"));

    expect(result.returnTo).toBe(EXTENSION_CONNECT_RETURN_TO);
  });

  it.each([
    ["a same-origin path", "/settings"],
    ["an absolute URL", "https://evil.example/auth/connect-extension"],
    ["a malformed connect path", "/auth/connect-extension?state=short"],
  ])(
    "drops %s carried by the state so the callback falls back to the feed",
    async (_label, returnTo) => {
      const oauth = oauthSession(DID);
      clientHolder.current = fakeClient({
        callback: vi.fn().mockResolvedValue({
          session: oauth,
          state: JSON.stringify({ returnTo }),
        }),
      });

      const result = await finishAtprotoAuth(new URLSearchParams("code=abc"));

      expect(result.returnTo).toBeNull();
    },
  );

  it("defers handle resolution on request so binding never waits on it", async () => {
    const oauth = oauthSession(DID);
    const client = fakeClient({
      callback: vi.fn().mockResolvedValue({ session: oauth, state: null }),
      handle: "reader.bsky.social",
    });
    clientHolder.current = client;

    const result = await finishAtprotoAuth(new URLSearchParams("code=abc"), {
      deferHandleResolution: true,
    });

    expect(result.handle).toBeNull();
    expect(client.oauthResolver.resolveIdentity).not.toHaveBeenCalled();
    expect((await connectionRow())?.handle).toBeNull();

    // The deferred backfill the link callback fires stores the handle.
    await expect(resolveAndStoreAtprotoHandle(DID)).resolves.toBe(
      "reader.bsky.social",
    );
    expect((await connectionRow())?.handle).toBe("reader.bsky.social");
  });

  it("surfaces the link state's user and passes the redirect URI through", async () => {
    const oauth = oauthSession(DID);
    const callback = vi.fn().mockResolvedValue({
      session: oauth,
      state: JSON.stringify({ linkUserId: "user-1" }),
    });
    clientHolder.current = fakeClient({ callback });

    const result = await finishAtprotoAuth(new URLSearchParams("code=abc"), {
      redirectUri: "https://serial.test/api/auth/atproto/link-callback",
    });

    expect(result.linkUserId).toBe("user-1");
    // The code exchange must run against the link redirect URI, not the
    // default sign-in callback.
    expect(callback).toHaveBeenCalledWith(expect.any(URLSearchParams), {
      redirect_uri: "https://serial.test/api/auth/atproto/link-callback",
    });
  });

  it("surfaces a failed callback validation and persists nothing", async () => {
    clientHolder.current = fakeClient({
      callback: vi.fn().mockRejectedValue(new Error("Invalid state")),
    });

    await expect(
      finishAtprotoAuth(new URLSearchParams("code=replayed")),
    ).rejects.toThrow(/Invalid state/);
    expect((await connectionRow())?.handle).toBeNull();
  });

  it("surfaces a DID to PDS chain mismatch from the SDK", async () => {
    clientHolder.current = fakeClient({
      callback: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Issuer mismatch: PDS does not trust this authorization server",
          ),
        ),
    });

    await expect(
      finishAtprotoAuth(
        new URLSearchParams("code=abc&iss=https://evil.example"),
      ),
    ).rejects.toThrow(/Issuer mismatch/);
    expect((await connectionRow())?.handle).toBeNull();
  });

  it("rejects an upgrade that comes back for a different subject", async () => {
    const oauth = oauthSession(OTHER_DID);
    clientHolder.current = fakeClient({
      callback: vi.fn().mockResolvedValue({
        session: oauth,
        state: JSON.stringify({ expectedDid: DID }),
      }),
    });

    await expect(
      finishAtprotoAuth(new URLSearchParams("code=abc")),
    ).rejects.toThrow(
      `Authorization returned ${OTHER_DID} but the flow was started for ${DID}`,
    );
    // The session the SDK just stored for the wrong subject is destroyed.
    expect(oauth.signOut).toHaveBeenCalledOnce();
  });

  it("accepts an upgrade that comes back for the pinned subject", async () => {
    const oauth = oauthSession(DID);
    clientHolder.current = fakeClient({
      callback: vi.fn().mockResolvedValue({
        session: oauth,
        state: JSON.stringify({ expectedDid: DID }),
      }),
    });

    const result = await finishAtprotoAuth(new URLSearchParams("code=abc"));

    expect(result.did).toBe(DID);
    expect(oauth.signOut).not.toHaveBeenCalled();
  });

  it("surfaces the upgrade state's user and pending settings", async () => {
    const oauth = oauthSession(DID);
    clientHolder.current = fakeClient({
      callback: vi.fn().mockResolvedValue({
        session: oauth,
        state: JSON.stringify({
          expectedDid: DID,
          upgradeUserId: "user-1",
          pendingSyncPreferences: { method: "export", importAsInactive: true },
        }),
      }),
    });

    const result = await finishAtprotoAuth(new URLSearchParams("code=abc"), {
      deferHandleResolution: true,
    });

    expect(result.upgradeUserId).toBe("user-1");
    expect(result.pendingSyncPreferences).toEqual({
      method: "export",
      importAsInactive: true,
    });
  });

  it("drops malformed pending settings carried by the state", async () => {
    const oauth = oauthSession(DID);
    clientHolder.current = fakeClient({
      callback: vi.fn().mockResolvedValue({
        session: oauth,
        state: JSON.stringify({
          expectedDid: DID,
          upgradeUserId: "user-1",
          pendingSyncPreferences: { method: "everything" },
        }),
      }),
    });

    const result = await finishAtprotoAuth(new URLSearchParams("code=abc"), {
      deferHandleResolution: true,
    });

    expect(result.pendingSyncPreferences).toBeNull();
  });

  it("treats an unresolvable handle as display data, not a failure", async () => {
    const oauth = oauthSession(DID);
    clientHolder.current = fakeClient({
      callback: vi.fn().mockResolvedValue({ session: oauth, state: null }),
      resolveError: new Error("resolution timed out"),
    });

    const result = await finishAtprotoAuth(new URLSearchParams("code=abc"));

    expect(result.did).toBe(DID);
    expect(result.handle).toBeNull();
  });

  it("ignores the placeholder handle the network returns for unresolvable identities", async () => {
    const oauth = oauthSession(DID);
    clientHolder.current = fakeClient({
      callback: vi.fn().mockResolvedValue({ session: oauth, state: null }),
      handle: "handle.invalid",
    });

    const result = await finishAtprotoAuth(new URLSearchParams("code=abc"));

    expect(result.handle).toBeNull();
    expect((await connectionRow())?.handle).toBeNull();
  });
});

describe("startAtprotoAuth", () => {
  let session: Session;
  let target: Target;

  beforeEach(async () => {
    target = createLocalBenchmarkTarget();
    session = openBenchmarkDatabase({ url: target.url });
    await applyMigrations(session.baseClient);
    dbHolder.current = session.database;
  });

  afterEach(() => {
    session.close();
    target.cleanup();
    dbHolder.current = undefined;
    clientHolder.current = undefined;
  });

  it("threads the return destination through the app state only when given one", async () => {
    const authorize = vi
      .fn()
      .mockResolvedValue(new URL("https://pds.example/authorize"));
    clientHolder.current = fakeClient({ authorize });

    await startAtprotoAuth({ identifier: "user.example.com" });
    expect(authorize).toHaveBeenLastCalledWith(
      "user.example.com",
      expect.not.objectContaining({ state: expect.anything() }),
    );

    await startAtprotoAuth({
      identifier: "user.example.com",
      returnTo: EXTENSION_CONNECT_RETURN_TO,
    });
    // Sign-in always requests the full grant: every sign-in replaces the
    // stored scopes, so a narrower one would strip write scope.
    expect(authorize).toHaveBeenLastCalledWith("user.example.com", {
      scope: "atproto include:site.standard.authSocial",
      state: JSON.stringify({ returnTo: EXTENSION_CONNECT_RETURN_TO }),
    });
  });
});

describe("revokeAtprotoConnection", () => {
  let session: Session;
  let target: Target;

  beforeEach(async () => {
    target = createLocalBenchmarkTarget();
    session = openBenchmarkDatabase({ url: target.url });
    await applyMigrations(session.baseClient);
    dbHolder.current = session.database;

    await session.database.insert(atprotoConnections).values({
      did: DID,
      session: "encrypted-blob",
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
    clientHolder.current = undefined;
  });

  async function connectionRow() {
    const rows = await session.database.select().from(atprotoConnections).all();
    return rows[0];
  }

  it("disconnects even when the SDK's revoke silently returns", async () => {
    // The SDK swallows expected session errors (an unreadable blob after a
    // key rotation) and returns without touching the store.
    clientHolder.current = { revoke: vi.fn().mockResolvedValue(undefined) };

    await revokeAtprotoConnection(DID);

    const row = await connectionRow();
    expect(row?.status).toBe("disconnected");
    expect(row?.session).toBeNull();
  });

  it("disconnects when the server-side revocation throws", async () => {
    clientHolder.current = {
      revoke: vi.fn().mockRejectedValue(new Error("authorization server down")),
    };

    await expect(revokeAtprotoConnection(DID)).resolves.toBeUndefined();

    const row = await connectionRow();
    expect(row?.status).toBe("disconnected");
    expect(row?.session).toBeNull();
  });
});
