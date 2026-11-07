/** Loopback OAuth authorization server, PLC directory and PDS for release tests. */
import { createServer } from "node:http";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { z } from "zod";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { attachJetstream } from "./jetstream-server";
import type { IncomingMessage } from "node:http";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1)
  throw new Error("A fixture port is required");
const origin = `http://127.0.0.1:${port}`;
type RecordValue = Record<string, unknown>;
type StoredRecord = { uri: string; cid: string; value: RecordValue };
type Grant = { did: string; scope: string; key: string; clientId: string };
type Authorization = Grant & {
  redirectUri: string;
  state: string;
  challenge: string;
};
const requests = new Map<string, Authorization>();
const codes = new Map<string, Authorization>();
const tokens = new Map<string, Grant>();
const refreshTokens = new Map<string, Grant>();
const records = new Map<string, StoredRecord>();
const revisions = new Map<string, number>();
const proofs = new Set<string>();
const paused = new Map<
  string,
  { promise: Promise<void>; release: () => void; waiting: boolean }
>();
const writes: Array<{ method: string; uri: string }> = [];

function hash(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    requireValue(size < 1024 * 1024, "Request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}
function dpop(request: IncomingMessage, url: URL, accessToken?: string) {
  const jwt = request.headers.dpop;
  requireValue(typeof jwt === "string", "Missing DPoP proof");
  const [head, payload, signature] = jwt.split(".");
  requireValue(head && payload && signature, "Invalid DPoP proof");
  const header = z
    .object({
      typ: z.literal("dpop+jwt"),
      alg: z.literal("ES256"),
      jwk: z.object({
        kty: z.literal("EC"),
        crv: z.literal("P-256"),
        x: z.string(),
        y: z.string(),
        d: z.never().optional(),
      }),
    })
    .parse(JSON.parse(Buffer.from(head, "base64url").toString()));
  const claims = z
    .object({
      htm: z.string(),
      htu: z.string(),
      iat: z.number(),
      jti: z.string(),
      ath: z.string().optional(),
    })
    .parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
  requireValue(
    header.typ === "dpop+jwt" && header.alg === "ES256",
    "Invalid DPoP algorithm",
  );
  requireValue(!header.jwk.d, "Private key in DPoP proof");
  requireValue(
    verify(
      "sha256",
      Buffer.from(`${head}.${payload}`),
      {
        key: createPublicKey({ key: header.jwk, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(signature, "base64url"),
    ),
    "Invalid DPoP signature",
  );
  requireValue(
    claims.htm === request.method &&
      claims.htu === `${url.origin}${url.pathname}`,
    "Invalid DPoP target",
  );
  requireValue(
    Math.abs(Date.now() / 1000 - claims.iat) < 300,
    "Expired DPoP proof",
  );
  requireValue(
    typeof claims.jti === "string" && !proofs.has(claims.jti),
    "Replayed DPoP proof",
  );
  if (accessToken)
    requireValue(claims.ath === hash(accessToken), "Invalid token binding");
  proofs.add(claims.jti);
  return hash(
    JSON.stringify({
      crv: header.jwk.crv,
      kty: header.jwk.kty,
      x: header.jwk.x,
      y: header.jwk.y,
    }),
  );
}
function recordCid(value: string) {
  const digest = createHash("sha256").update(value).digest();
  return CID.createV1(0x71, createDigest(0x12, digest)).toString();
}
function store(
  repo: string,
  collection: string,
  rkey: string,
  value: RecordValue,
) {
  const uri = `at://${repo}/${collection}/${rkey}`;
  const revision = (revisions.get(repo) ?? 0) + 1;
  revisions.set(repo, revision);
  const record = {
    uri,
    cid: recordCid(JSON.stringify(value)),
    value,
  };
  records.set(uri, record);
  stream.commit(repo, collection, rkey, revision, record);
  return record;
}
function remove(repo: string, uri: string) {
  records.delete(uri);
  revisions.set(repo, (revisions.get(repo) ?? 0) + 1);
  const [, , , collection, rkey] = uri.split("/");
  stream.commit(repo, collection!, rkey!, revisions.get(repo)!);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", origin);
  const json = (value: unknown, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  try {
    if (url.pathname === "/") return json({ ready: true });
    if (decodeURIComponent(url.pathname).startsWith("/did:plc:")) {
      const did = decodeURIComponent(url.pathname.slice(1));
      return json({
        id: did,
        service: [
          {
            id: "#atproto_pds",
            type: "AtprotoPersonalDataServer",
            serviceEndpoint: origin,
          },
        ],
      });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return json({ resource: origin, authorization_servers: [origin] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        pushed_authorization_request_endpoint: `${origin}/oauth/par`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        token_endpoint_auth_methods_supported: ["none"],
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        dpop_signing_alg_values_supported: ["ES256"],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
        require_pushed_authorization_requests: true,
        scopes_supported: ["atproto", "include:site.standard.authSocial"],
      });
    }
    if (url.pathname === "/oauth/par") {
      const params = new URLSearchParams(await body(request));
      const key = dpop(request, url);
      const did = params.get("login_hint") ?? "";
      requireValue(/^did:plc:[a-z2-7]{24}$/.test(did), "Expected fixture DID");
      const redirectUri = params.get("redirect_uri") ?? "";
      requireValue(
        new URL(redirectUri).hostname === "127.0.0.1",
        "Expected loopback callback",
      );
      requireValue(
        params.get("code_challenge_method") === "S256",
        "Expected PKCE",
      );
      const id = `urn:ietf:params:oauth:request_uri:${randomUUID()}`;
      requests.set(id, {
        did,
        scope: params.get("scope") ?? "",
        key,
        clientId: params.get("client_id") ?? "",
        redirectUri,
        state: params.get("state") ?? "",
        challenge: params.get("code_challenge") ?? "",
      });
      return json({ request_uri: id, expires_in: 300 }, 201);
    }
    if (url.pathname === "/oauth/authorize") {
      const id = url.searchParams.get("request_uri") ?? "";
      const auth = requests.get(id);
      requireValue(
        auth && auth.clientId === url.searchParams.get("client_id"),
        "Unknown authorization request",
      );
      const decision = url.searchParams.get("decision");
      if (!decision) {
        const approve = new URL(url);
        approve.searchParams.set("decision", "approve");
        const deny = new URL(url);
        deny.searchParams.set("decision", "deny");
        const escape = (value: string) =>
          value
            .replaceAll("&", "&amp;")
            .replaceAll('"', "&quot;")
            .replaceAll("<", "&lt;");
        response.writeHead(200, { "Content-Type": "text/html" });
        return response.end(
          `<h1>Authorize Serial</h1><p>${escape(auth.scope)}</p><a href="${escape(approve.href)}">Approve</a><a href="${escape(deny.href)}">Deny</a>`,
        );
      }
      requests.delete(id);
      const callback = new URL(auth.redirectUri);
      callback.searchParams.set("state", auth.state);
      callback.searchParams.set("iss", origin);
      if (decision === "approve") {
        const code = randomUUID();
        codes.set(code, auth);
        callback.searchParams.set("code", code);
      } else callback.searchParams.set("error", "access_denied");
      response.writeHead(302, { Location: callback.href });
      return response.end();
    }
    if (url.pathname === "/oauth/token") {
      const params = new URLSearchParams(await body(request));
      const key = dpop(request, url);
      let grant: Grant | undefined;
      if (params.get("grant_type") === "authorization_code") {
        const code = params.get("code") ?? "";
        const auth = codes.get(code);
        codes.delete(code);
        requireValue(
          auth &&
            auth.redirectUri === params.get("redirect_uri") &&
            auth.challenge === hash(params.get("code_verifier") ?? ""),
          "Invalid authorization code or PKCE",
        );
        grant = auth;
      } else if (params.get("grant_type") === "refresh_token") {
        const token = params.get("refresh_token") ?? "";
        grant = refreshTokens.get(token);
        refreshTokens.delete(token);
      }
      requireValue(
        grant &&
          grant.key === key &&
          grant.clientId === params.get("client_id"),
        "Invalid grant binding",
      );
      const access = randomUUID(),
        refresh = randomUUID();
      tokens.set(access, grant);
      refreshTokens.set(refresh, grant);
      return json({
        access_token: access,
        refresh_token: refresh,
        token_type: "DPoP",
        expires_in: 3600,
        sub: grant.did,
        scope: grant.scope,
      });
    }
    if (url.pathname === "/oauth/revoke") {
      const params = new URLSearchParams(await body(request));
      const token = params.get("token") ?? "";
      tokens.delete(token);
      refreshTokens.delete(token);
      return json({});
    }
    // Test controls share the loopback-only server. They never enter product code.
    if (url.pathname === "/control" && request.method === "POST") {
      const input = z
        .object({
          operation: z.enum(["put", "delete", "inspect", "pause", "release"]),
          repo: z.string(),
          collection: z.string().default(""),
          rkey: z.string().default(""),
          value: z.record(z.string(), z.unknown()).default({}),
        })
        .parse(JSON.parse(await body(request)));
      if (input.operation === "pause") {
        requireValue(!paused.has(input.repo), "Repository already paused");
        let release!: () => void;
        const promise = new Promise<void>((resolve) => {
          release = resolve;
        });
        paused.set(input.repo, { promise, release, waiting: false });
      }
      if (input.operation === "release") {
        paused.get(input.repo)?.release();
        paused.delete(input.repo);
      }
      if (input.operation === "put")
        return json(
          store(input.repo, input.collection, input.rkey, input.value),
        );
      if (input.operation === "delete")
        remove(
          input.repo,
          `at://${input.repo}/${input.collection}/${input.rkey}`,
        );
      return json({
        records: [...records.values()].filter((record) =>
          record.uri.startsWith(`at://${input.repo}/`),
        ),
        writes,
        waiting: paused.get(input.repo)?.waiting ?? false,
      });
    }
    if (url.pathname.startsWith("/xrpc/")) {
      const method = url.pathname.slice(6);
      const input = z
        .object({
          repo: z.string().optional(),
          did: z.string().optional(),
          collection: z.string().default(""),
          rkey: z.string().default(""),
          cursor: z.string().optional(),
          limit: z.coerce.number().positive().optional(),
          reverse: z.string().optional(),
          swapRecord: z.string().nullable().optional(),
          record: z.record(z.string(), z.unknown()).default({}),
        })
        .parse(
          request.method === "POST"
            ? JSON.parse(await body(request))
            : Object.fromEntries(url.searchParams),
        );
      const repo = input.repo ?? input.did;
      requireValue(repo, "Missing repository");
      const uri = `at://${repo}/${input.collection}/${input.rkey}`;
      if (method === "com.atproto.sync.getLatestCommit")
        return json({
          cid: `fixture-${revisions.get(repo) ?? 0}`,
          rev: String(revisions.get(repo) ?? 0),
        });
      if (method === "com.atproto.repo.listRecords") {
        const gate = paused.get(repo);
        if (gate && input.collection === "site.standard.graph.subscription") {
          gate.waiting = true;
          await gate.promise;
        }
        const all = [...records.values()]
          .filter((record) =>
            record.uri.startsWith(`at://${repo}/${input.collection}/`),
          )
          // Descending by URI like the reference PDS; `reverse` flips it.
          .sort((a, b) =>
            input.reverse === "true"
              ? a.uri.localeCompare(b.uri)
              : b.uri.localeCompare(a.uri),
          );
        const offset = Number(input.cursor ?? 0),
          limit = Math.min(Number(input.limit ?? 100), 100);
        return json({
          records: all.slice(offset, offset + limit),
          ...(offset + limit < all.length
            ? { cursor: String(offset + limit) }
            : {}),
        });
      }
      if (method === "com.atproto.repo.getRecord") {
        const record = records.get(uri);
        return record ? json(record) : json({ error: "RecordNotFound" }, 404);
      }
      const access = request.headers.authorization?.replace(/^DPoP /, "") ?? "";
      const grant = tokens.get(access);
      requireValue(
        grant &&
          grant.did === repo &&
          grant.scope.split(" ").includes("include:site.standard.authSocial"),
        "Unauthorized repository write",
      );
      requireValue(
        dpop(request, url, access) === grant.key,
        "Invalid write proof binding",
      );
      requireValue(
        input.collection === "site.standard.graph.subscription",
        "Unexpected write collection",
      );
      if (
        input.swapRecord !== undefined &&
        input.swapRecord !== (records.get(uri)?.cid ?? null)
      )
        return json({ error: "InvalidSwap" }, 400);
      if (method === "com.atproto.repo.putRecord") {
        const record = store(repo, input.collection, input.rkey, input.record);
        writes.push({ method, uri });
        return json({ uri, cid: record.cid });
      }
      if (method === "com.atproto.repo.deleteRecord") {
        remove(repo, uri);
        writes.push({ method, uri });
        return json({});
      }
    }
    json({ error: "NotFound" }, 404);
  } catch (error) {
    json(
      {
        error: "InvalidRequest",
        message:
          error instanceof Error ? error.message : "Invalid fixture request",
      },
      400,
    );
  }
});
const stream = attachJetstream(server);
server.listen(port, "127.0.0.1");
