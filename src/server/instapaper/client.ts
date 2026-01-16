import { createHmac, randomBytes } from "crypto";
import { env } from "~/env";

const INSTAPAPER_API_BASE = "https://www.instapaper.com";

interface OAuthParams {
  oauth_consumer_key: string;
  oauth_signature_method: string;
  oauth_timestamp: string;
  oauth_nonce: string;
  oauth_version: string;
  oauth_token?: string;
  oauth_signature?: string;
  [key: string]: string | undefined;
}

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

function generateTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

function createSignatureBaseString(
  method: string,
  url: string,
  params: Record<string, string>
): string {
  const sortedParams = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key]!)}`)
    .join("&");

  return `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(sortedParams)}`;
}

function createSignature(
  baseString: string,
  consumerSecret: string,
  tokenSecret = ""
): string {
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const hmac = createHmac("sha1", signingKey);
  hmac.update(baseString);
  return hmac.digest("base64");
}

function createAuthorizationHeader(params: OAuthParams): string {
  const headerParams = Object.entries(params)
    .filter(([key]) => key.startsWith("oauth_"))
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value!)}"`)
    .join(", ");

  return `OAuth ${headerParams}`;
}

export interface InstapaperTokens {
  oauthToken: string;
  oauthTokenSecret: string;
}

export async function getAccessToken(
  username: string,
  password: string
): Promise<InstapaperTokens> {
  const consumerKey = env.INSTAPAPER_OAUTH_ID;
  const consumerSecret = env.INSTAPAPER_OAUTH_SECRET;

  if (!consumerKey || !consumerSecret) {
    throw new Error("Instapaper OAuth credentials not configured");
  }

  const url = `${INSTAPAPER_API_BASE}/api/1/oauth/access_token`;

  const oauthParams: OAuthParams = {
    oauth_consumer_key: consumerKey,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: generateTimestamp(),
    oauth_nonce: generateNonce(),
    oauth_version: "1.0",
  };

  const bodyParams: Record<string, string> = {
    x_auth_username: username,
    x_auth_password: password,
    x_auth_mode: "client_auth",
  };

  const allParams: Record<string, string> = { ...oauthParams, ...bodyParams };
  const baseString = createSignatureBaseString("POST", url, allParams);
  const signature = createSignature(baseString, consumerSecret);

  oauthParams.oauth_signature = signature;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: createAuthorizationHeader(oauthParams),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(bodyParams).toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Instapaper auth failed: ${response.status} - ${text}`);
  }

  const responseText = await response.text();
  const responseParams = new URLSearchParams(responseText);

  const oauthToken = responseParams.get("oauth_token");
  const oauthTokenSecret = responseParams.get("oauth_token_secret");

  if (!oauthToken || !oauthTokenSecret) {
    throw new Error("Invalid response from Instapaper");
  }

  return { oauthToken, oauthTokenSecret };
}

export interface AddBookmarkParams {
  url: string;
  title?: string;
  description?: string;
  content?: string;
}

export async function addBookmark(
  tokens: InstapaperTokens,
  params: AddBookmarkParams
): Promise<{ bookmark_id: number }> {
  const consumerKey = env.INSTAPAPER_OAUTH_ID;
  const consumerSecret = env.INSTAPAPER_OAUTH_SECRET;

  if (!consumerKey || !consumerSecret) {
    throw new Error("Instapaper OAuth credentials not configured");
  }

  const url = `${INSTAPAPER_API_BASE}/api/1/bookmarks/add`;

  const oauthParams: OAuthParams = {
    oauth_consumer_key: consumerKey,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: generateTimestamp(),
    oauth_nonce: generateNonce(),
    oauth_version: "1.0",
    oauth_token: tokens.oauthToken,
  };

  const bodyParams: Record<string, string> = {
    url: params.url,
  };

  if (params.title) {
    bodyParams.title = params.title;
  }
  if (params.description) {
    bodyParams.description = params.description;
  }
  if (params.content) {
    bodyParams.content = params.content;
  }

  const allParams: Record<string, string> = { ...oauthParams, ...bodyParams };
  const baseString = createSignatureBaseString("POST", url, allParams);
  const signature = createSignature(
    baseString,
    consumerSecret,
    tokens.oauthTokenSecret
  );

  oauthParams.oauth_signature = signature;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: createAuthorizationHeader(oauthParams),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(bodyParams).toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to add bookmark: ${response.status} - ${text}`);
  }

  const data = await response.json();
  return { bookmark_id: data[0]?.bookmark_id };
}

export async function verifyCredentials(
  tokens: InstapaperTokens
): Promise<boolean> {
  const consumerKey = env.INSTAPAPER_OAUTH_ID;
  const consumerSecret = env.INSTAPAPER_OAUTH_SECRET;

  if (!consumerKey || !consumerSecret) {
    return false;
  }

  const url = `${INSTAPAPER_API_BASE}/api/1/account/verify_credentials`;

  const oauthParams: OAuthParams = {
    oauth_consumer_key: consumerKey,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: generateTimestamp(),
    oauth_nonce: generateNonce(),
    oauth_version: "1.0",
    oauth_token: tokens.oauthToken,
  };

  const baseString = createSignatureBaseString("POST", url, oauthParams);
  const signature = createSignature(
    baseString,
    consumerSecret,
    tokens.oauthTokenSecret
  );

  oauthParams.oauth_signature = signature;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: createAuthorizationHeader(oauthParams),
    },
  });

  return response.ok;
}
