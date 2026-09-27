// server/_core/app.ts
import "dotenv/config";
import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

// shared/const.ts
var COOKIE_NAME = "app_session_id";
var ONE_YEAR_MS = 1e3 * 60 * 60 * 24 * 365;
var AXIOS_TIMEOUT_MS = 3e4;
var UNAUTHED_ERR_MSG = "Please login (10001)";
var NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";
var OAUTH_STATE_COOKIE = "__Host-oauth_state";
var decodeOAuthState = (state) => {
  let decoded;
  try {
    decoded = atob(state);
  } catch {
    return { redirectUri: "" };
  }
  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed.redirectUri === "string") return parsed;
  } catch {
  }
  return { redirectUri: decoded };
};

// server/_core/oauth.ts
import { parse as parseCookieHeader2 } from "cookie";

// server/db.ts
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";

// drizzle/schema.ts
import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";
var users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull()
});
var researchSessions = mysqlTable("research_sessions", {
  id: varchar("id", { length: 36 }).primaryKey(),
  goal: text("goal").notNull(),
  status: varchar("status", { length: 24 }).notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  snapshot: text("snapshot").notNull()
});

// server/_core/env.ts
var ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL || process.env.LLM_BASE_URL || "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || ""
};

// server/db.ts
var _db = null;
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}
async function upsertUser(user) {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }
  try {
    const values = {
      openId: user.openId
    };
    const updateSet = {};
    const textFields = ["name", "email", "loginMethod"];
    const assignNullable = (field) => {
      const value = user[field];
      if (value === void 0) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== void 0) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== void 0) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }
    if (!values.lastSignedIn) {
      values.lastSignedIn = /* @__PURE__ */ new Date();
    }
    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = /* @__PURE__ */ new Date();
    }
    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}
async function getUserByOpenId(openId) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return void 0;
  }
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : void 0;
}

// server/_core/cookies.ts
function isSecureRequest(req) {
  if (req.protocol === "https") return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;
  const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");
  return protoList.some((proto) => proto.trim().toLowerCase() === "https");
}
function getSessionCookieOptions(req) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "none",
    secure: isSecureRequest(req)
  };
}

// shared/_core/errors.ts
var HttpError = class extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpError";
  }
};
var ForbiddenError = (msg) => new HttpError(403, msg);

// server/_core/sdk.ts
import axios from "axios";
import { parse as parseCookieHeader } from "cookie";
import { SignJWT, jwtVerify } from "jose";
var isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
var EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
var GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;
var GET_USER_INFO_WITH_JWT_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt`;
var OAuthService = class {
  constructor(client) {
    this.client = client;
    console.log("[OAuth] Initialized with baseURL:", ENV.oAuthServerUrl);
    if (!ENV.oAuthServerUrl) {
      console.error(
        "[OAuth] ERROR: OAUTH_SERVER_URL is not configured! Set OAUTH_SERVER_URL environment variable."
      );
    }
  }
  decodeState(state) {
    return decodeOAuthState(state).redirectUri;
  }
  async getTokenByCode(code, state) {
    const payload = {
      clientId: ENV.appId,
      grantType: "authorization_code",
      code,
      redirectUri: this.decodeState(state)
    };
    const { data } = await this.client.post(
      EXCHANGE_TOKEN_PATH,
      payload
    );
    return data;
  }
  async getUserInfoByToken(token) {
    const { data } = await this.client.post(
      GET_USER_INFO_PATH,
      {
        accessToken: token.accessToken
      }
    );
    return data;
  }
};
var createOAuthHttpClient = () => axios.create({
  baseURL: ENV.oAuthServerUrl,
  timeout: AXIOS_TIMEOUT_MS
});
var SDKServer = class {
  client;
  oauthService;
  constructor(client = createOAuthHttpClient()) {
    this.client = client;
    this.oauthService = new OAuthService(this.client);
  }
  deriveLoginMethod(platforms, fallback) {
    if (fallback && fallback.length > 0) return fallback;
    if (!Array.isArray(platforms) || platforms.length === 0) return null;
    const set = new Set(
      platforms.filter((p) => typeof p === "string")
    );
    if (set.has("REGISTERED_PLATFORM_EMAIL")) return "email";
    if (set.has("REGISTERED_PLATFORM_GOOGLE")) return "google";
    if (set.has("REGISTERED_PLATFORM_APPLE")) return "apple";
    if (set.has("REGISTERED_PLATFORM_MICROSOFT") || set.has("REGISTERED_PLATFORM_AZURE"))
      return "microsoft";
    if (set.has("REGISTERED_PLATFORM_GITHUB")) return "github";
    const first = Array.from(set)[0];
    return first ? first.toLowerCase() : null;
  }
  /**
   * Exchange OAuth authorization code for access token
   * @example
   * const tokenResponse = await sdk.exchangeCodeForToken(code, state);
   */
  async exchangeCodeForToken(code, state) {
    return this.oauthService.getTokenByCode(code, state);
  }
  /**
   * Get user information using access token
   * @example
   * const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
   */
  async getUserInfo(accessToken) {
    const data = await this.oauthService.getUserInfoByToken({
      accessToken
    });
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  parseCookies(cookieHeader) {
    if (!cookieHeader) {
      return /* @__PURE__ */ new Map();
    }
    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }
  getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }
  /**
   * Create a session token for a Manus user openId
   * @example
   * const sessionToken = await sdk.createSessionToken(userInfo.openId);
   */
  async createSessionToken(openId, options = {}) {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: options.name || ""
      },
      options
    );
  }
  async signSession(payload, options = {}) {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1e3);
    const secretKey = this.getSessionSecret();
    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name
    }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setExpirationTime(expirationSeconds).sign(secretKey);
  }
  async verifySession(cookieValue) {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }
    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"]
      });
      const { openId, appId, name } = payload;
      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }
      return {
        openId,
        appId,
        name
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }
  async getUserInfoWithJwt(jwtToken) {
    const payload = {
      jwtToken,
      projectId: ENV.appId
    };
    const { data } = await this.client.post(
      GET_USER_INFO_WITH_JWT_PATH,
      payload
    );
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  async authenticateRequest(req) {
    const cookies = this.parseCookies(req.headers.cookie);
    let sessionToken = cookies.get(COOKIE_NAME);
    if (!sessionToken) {
      const authHeader = req.headers.authorization;
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        sessionToken = authHeader.slice(7);
      }
    }
    const session = await this.verifySession(sessionToken);
    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }
    if (session.openId.startsWith(CRON_OPEN_ID_PREFIX)) {
      const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
      const taskUid = userInfo.taskUid ?? null;
      if (!taskUid) {
        throw ForbiddenError("Cron session missing task_uid");
      }
      return buildCronUser(userInfo);
    }
    const sessionUserId = session.openId;
    const signedInAt = /* @__PURE__ */ new Date();
    let user = await getUserByOpenId(sessionUserId);
    if (!user) {
      try {
        const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
        await upsertUser({
          openId: userInfo.openId,
          name: userInfo.name || null,
          email: userInfo.email ?? null,
          loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
          lastSignedIn: signedInAt
        });
        user = await getUserByOpenId(userInfo.openId);
      } catch (error) {
        console.error("[Auth] Failed to sync user from OAuth:", error);
        throw ForbiddenError("Failed to sync user info");
      }
    }
    if (!user) {
      throw ForbiddenError("User not found");
    }
    await upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt
    });
    return user;
  }
};
var CRON_OPEN_ID_PREFIX = "cron_";
function buildCronUser(userInfo) {
  const now = /* @__PURE__ */ new Date();
  return {
    id: -1,
    openId: userInfo.openId,
    name: userInfo.name || "Manus Scheduled Task",
    email: null,
    loginMethod: null,
    role: "user",
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
    taskUid: userInfo.taskUid ?? void 0,
    isCron: true
  };
}
var sdk = new SDKServer();

// server/_core/oauth.ts
function getQueryParam(req, key) {
  const value = req.query[key];
  return typeof value === "string" ? value : void 0;
}
function registerOAuthRoutes(app2) {
  app2.get("/api/oauth/callback", async (req, res) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");
    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }
    const { nonce } = decodeOAuthState(state);
    const expectedNonce = parseCookieHeader2(req.headers.cookie ?? "")[OAUTH_STATE_COOKIE];
    if (!nonce || nonce !== expectedNonce) {
      res.status(403).json({ error: "invalid oauth state" });
      return;
    }
    res.clearCookie(OAUTH_STATE_COOKIE, { path: "/", secure: true, sameSite: "none" });
    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }
      await upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: /* @__PURE__ */ new Date()
      });
      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS
      });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect(302, "/");
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}

// server/_core/storageProxy.ts
function registerStorageProxy(app2) {
  app2.get("/manus-storage/*", async (req, res) => {
    const key = req.params[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }
    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }
    try {
      const forgeUrl = new URL(
        "v1/storage/presign/get",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/"
      );
      forgeUrl.searchParams.set("path", key);
      const forgeResp = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` }
      });
      if (!forgeResp.ok) {
        const body = await forgeResp.text().catch(() => "");
        console.error(`[StorageProxy] forge error: ${forgeResp.status} ${body}`);
        res.status(502).send("Storage backend error");
        return;
      }
      const { url } = await forgeResp.json();
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}

// server/_core/systemRouter.ts
import { z } from "zod";

// server/_core/notification.ts
import { TRPCError } from "@trpc/server";
var TITLE_MAX_LENGTH = 1200;
var CONTENT_MAX_LENGTH = 2e4;
var trimValue = (value) => value.trim();
var isNonEmptyString2 = (value) => typeof value === "string" && value.trim().length > 0;
var buildEndpointUrl = (baseUrl) => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};
var validatePayload = (input) => {
  if (!isNonEmptyString2(input.title)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification title is required."
    });
  }
  if (!isNonEmptyString2(input.content)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification content is required."
    });
  }
  const title = trimValue(input.title);
  const content = trimValue(input.content);
  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`
    });
  }
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`
    });
  }
  return { title, content };
};
async function notifyOwner(payload) {
  const { title, content } = validatePayload(payload);
  if (!ENV.forgeApiUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service URL is not configured."
    });
  }
  if (!ENV.forgeApiKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service API key is not configured."
    });
  }
  const endpoint = buildEndpointUrl(ENV.forgeApiUrl);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "content-type": "application/json",
        "connect-protocol-version": "1"
      },
      body: JSON.stringify({ title, content })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[Notification] Failed to notify owner (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Notification] Error calling notification service:", error);
    return false;
  }
}

// server/_core/trpc.ts
import { initTRPC, TRPCError as TRPCError2 } from "@trpc/server";
import superjson from "superjson";
var t = initTRPC.context().create({
  transformer: superjson
});
var router = t.router;
var publicProcedure = t.procedure;
var requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  if (!ctx.user) {
    throw new TRPCError2({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user
    }
  });
});
var protectedProcedure = t.procedure.use(requireUser);
var adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;
    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError2({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    return next({
      ctx: {
        ...ctx,
        user: ctx.user
      }
    });
  })
);

// server/_core/systemRouter.ts
var systemRouter = router({
  health: publicProcedure.input(
    z.object({
      timestamp: z.number().min(0, "timestamp cannot be negative")
    })
  ).query(() => ({
    ok: true
  })),
  notifyOwner: adminProcedure.input(
    z.object({
      title: z.string().min(1, "title is required"),
      content: z.string().min(1, "content is required")
    })
  ).mutation(async ({ input }) => {
    const delivered = await notifyOwner(input);
    return {
      success: delivered
    };
  })
});

// server/research/router.ts
import { z as z2 } from "zod";

// server/research/engine.ts
import { randomUUID } from "node:crypto";

// server/research/tools.ts
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
var MAX_PAGE_CHARS = 9e3;
var MAX_FETCH_MS = 12e3;
var MAX_DNS_MS = 3e3;
var MAX_REDIRECTS = 4;
function decodeHtml(input) {
  return input.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
function stripHtml(input) {
  return decodeHtml(input.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function normalizeSearchUrl(raw) {
  try {
    const decoded = decodeHtml(raw);
    const parsed = new URL(decoded.startsWith("//") ? `https:${decoded}` : decoded, "https://duckduckgo.com");
    const target = parsed.searchParams.get("uddg");
    const url = new URL(target || parsed.toString());
    if (!/^https?:$/.test(url.protocol)) return null;
    if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}
function normalizeSearchQuery(query) {
  let clean = query.trim().slice(0, 1200);
  const suggested = clean.match(/(?:suggested queries|queries to try|focused searches)[^:\n]*:?\s*([\s\S]*)/i);
  if (suggested?.[1]) clean = suggested[1].trim();
  const firstListItem = clean.match(/(?:^|\n)\s*(?:1[.)]|[-*•])\s*([^\n]+)/);
  if (firstListItem?.[1]) clean = firstListItem[1].trim();
  if (clean.includes(";") && /\b(?:site:|(?:AI|workshop|university)\s)/i.test(clean)) clean = clean.split(";")[0].trim();
  return clean.replace(/[\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}
async function webSearch(query, maxResults = 5) {
  const cleanQuery = normalizeSearchQuery(query);
  if (cleanQuery.length < 2) throw new Error("Search query must contain at least two characters.");
  const broadenedQuery = cleanQuery.replace(/\bsite:[^\s)]+/gi, " ").replace(/\bOR\b/gi, " ").replace(/["'()|]/g, " ").replace(/\s+/g, " ").trim();
  const queries = Array.from(/* @__PURE__ */ new Set([cleanQuery, broadenedQuery])).filter((value) => value.length >= 2);
  let lastError = "The live search provider returned no parseable results.";
  for (const candidate of queries) {
    const endpoint = new URL("https://html.duckduckgo.com/html/");
    endpoint.searchParams.set("q", candidate);
    let html;
    try {
      const response = await fetch(endpoint, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(MAX_FETCH_MS) });
      if (!response.ok && response.status !== 202) {
        lastError = `Web search returned HTTP ${response.status}.`;
        continue;
      }
      html = await response.text();
    } catch (error) {
      lastError = error instanceof Error ? `Web search failed: ${error.message}` : "Web search failed with a network error.";
      continue;
    }
    const anchors = Array.from(html.matchAll(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*>[\s\S]*?<\/a>/gi));
    const seen = /* @__PURE__ */ new Set();
    const results = [];
    for (let index = 0; index < anchors.length && results.length < Math.min(Math.max(maxResults, 1), 8); index++) {
      const match = anchors[index];
      const tag = match[0].match(/^<a\b[^>]*>/i)?.[0] ?? "";
      const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
      if (!href) continue;
      const url = normalizeSearchUrl(href);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const next = anchors[index + 1]?.index ?? html.length;
      const region = html.slice(match.index ?? 0, next);
      const snippetMatch = region.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)(?:<\/a>|<\/div>)/i);
      const title = stripHtml(match[0].replace(/^<a\b[^>]*>/i, "").replace(/<\/a>$/i, ""));
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "Search result returned without a readable snippet.";
      if (!title) continue;
      results.push({ title, url, domain: new URL(url).hostname.replace(/^www\./, ""), snippet: snippet.slice(0, 900) });
    }
    if (results.length) return results;
    lastError = candidate === cleanQuery && broadenedQuery !== cleanQuery ? "The exact search returned no parseable results; retrying a simplified query." : "The live search provider returned no parseable results for either the original or simplified query.";
  }
  throw new Error(`${lastError} Try a shorter query without exact-phrase or site restrictions.`);
}
function isBlockedAddress(address) {
  if (address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || parts[0] === 169 && parts[1] === 254 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168 || parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}
async function lookupWithTimeout(host) {
  let timer;
  try {
    return await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Public host DNS lookup timed out.")), MAX_DNS_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function validatePublicUrl(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Only public HTTP(S) URLs are allowed.");
  const host = url.hostname.toLowerCase();
  if (["localhost", "metadata.google.internal"].includes(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Private or local hosts cannot be extracted.");
  }
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new Error("Private or local IP addresses cannot be extracted.");
  } else {
    const records = await lookupWithTimeout(host);
    if (!records.length || records.some((record) => isBlockedAddress(record.address))) throw new Error("The URL host does not resolve exclusively to public IP addresses.");
  }
  return url;
}
async function extractPage(urlValue) {
  let url = await validatePublicUrl(urlValue);
  let response;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain,application/xhtml+xml" },
      redirect: "manual",
      signal: AbortSignal.timeout(MAX_FETCH_MS)
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) break;
    if (redirectCount === MAX_REDIRECTS) throw new Error("Page extraction exceeded the allowed redirect count.");
    const nextUrl = new URL(location, url);
    await response.body?.cancel();
    url = await validatePublicUrl(nextUrl.toString());
    response = void 0;
  }
  if (!response) throw new Error("Page extraction could not reach a validated redirect target.");
  if (!response.ok) throw new Error(`Page extraction returned HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/(html|plain)|application\/xhtml\+xml/i.test(contentType)) throw new Error(`Unsupported page content type: ${contentType || "unknown"}.`);
  const html = (await response.text()).slice(0, 25e4);
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const text2 = stripHtml(html).slice(0, MAX_PAGE_CHARS);
  if (!text2) throw new Error("No readable text was extracted from this page.");
  return { title: title ? stripHtml(title).slice(0, 240) : url.hostname, text: text2 };
}
function calculate(expression) {
  const input = expression.replace(/\s+/g, "");
  if (!input || input.length > 160 || !/^[\d.+\-*/()%]+$/.test(input)) throw new Error("Only numeric arithmetic expressions are supported.");
  const tokens = input.match(/\d+(?:\.\d+)?|[()+\-*/%]/g) ?? [];
  if (tokens.join("") !== input) throw new Error("The arithmetic expression contains unsupported syntax.");
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const primary = () => {
    const token = take();
    if (token === "+") return primary();
    if (token === "-") return -primary();
    if (token === "(") {
      const value = expressionValue();
      if (take() !== ")") throw new Error("Unbalanced parentheses.");
      return value;
    }
    if (!token || !/^\d/.test(token)) throw new Error("Expected a number.");
    return Number(token);
  };
  const term = () => {
    let value = primary();
    while (["*", "/", "%"].includes(peek() ?? "")) {
      const op = take();
      const right = primary();
      if ((op === "/" || op === "%") && right === 0) throw new Error("Division by zero is not allowed.");
      value = op === "*" ? value * right : op === "/" ? value / right : value % right;
    }
    return value;
  };
  const expressionValue = () => {
    let value = term();
    while (peek() === "+" || peek() === "-") {
      const op = take();
      const right = term();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };
  const result = expressionValue();
  if (index !== tokens.length || !Number.isFinite(result) || Math.abs(result) > 1e15) throw new Error("The expression is incomplete or outside the supported range.");
  return Number(result.toFixed(6));
}
function calculateBatch(input) {
  if (!input.trim() || input.length > 900) throw new Error("A calculator batch must contain 1\u20136 bounded arithmetic equations.");
  const equations = input.split(/[;\n]+/).map((item) => item.trim()).filter(Boolean);
  if (!equations.length || equations.length > 6) throw new Error("A calculator batch must contain 1\u20136 bounded arithmetic equations.");
  return equations.map((equation) => {
    const parts = equation.split("=");
    if (parts.length > 2) throw new Error("Each calculator line may contain at most one result check.");
    const normalize = (value) => value.replace(/₹|INR/gi, "").replace(/,/g, "").replace(/×/g, "*").replace(/÷/g, "/").trim();
    const expression = normalize(parts[0]);
    const result = calculate(expression);
    if (parts.length === 2) {
      const claimedResult = calculate(normalize(parts[1]));
      if (claimedResult !== result) throw new Error("The supplied equation result does not match the calculator.");
    }
    return { expression, result };
  });
}
function readUserFile(name, content) {
  if (content.length > 8e4) throw new Error("Uploaded text is limited to 80,000 characters.");
  const extension = name.toLowerCase().split(".").pop();
  if (!extension || !["csv", "json", "txt", "md", "markdown"].includes(extension)) throw new Error("Supported file types: CSV, JSON, TXT, Markdown.");
  let summary = "Text file loaded.";
  if (extension === "json") {
    const parsed = JSON.parse(content);
    summary = `Valid JSON loaded (${Array.isArray(parsed) ? `${parsed.length} array items` : typeof parsed === "object" && parsed ? `${Object.keys(parsed).length} top-level keys` : "scalar value"}).`;
  } else if (extension === "csv") {
    const lines = content.split(/\r?\n/).filter((line) => line.trim());
    const header = (lines[0] ?? "").split(",").map((v) => v.trim());
    summary = `CSV loaded: ${Math.max(0, lines.length - 1)} data rows and ${header.length} columns (${header.slice(0, 12).join(", ")}).`;
  }
  return { name: name.slice(0, 180), characters: content.length, preview: content.slice(0, 15e3), summary };
}
function normalizeSearchRecords(records, retrievedAt = Date.now()) {
  const seen = /* @__PURE__ */ new Set();
  return records.filter((record) => {
    try {
      const url = new URL(record.url);
      if (!/^https?:$/.test(url.protocol) || seen.has(url.toString())) return false;
      seen.add(url.toString());
      return true;
    } catch {
      return false;
    }
  }).map((record, index) => ({
    id: `S${index + 1}`,
    title: record.title.slice(0, 240),
    url: record.url,
    domain: record.domain || new URL(record.url).hostname,
    snippet: record.snippet.slice(0, 900),
    retrievedAt
  }));
}

// server/_core/llm.ts
var ensureArray = (value) => Array.isArray(value) ? value : [value];
var normalizeContentPart = (part) => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }
  if (part.type === "text") {
    return part;
  }
  if (part.type === "image_url") {
    return part;
  }
  if (part.type === "file_url") {
    return part;
  }
  throw new Error("Unsupported message content part");
};
var normalizeMessage = (message) => {
  const { role, name, tool_call_id } = message;
  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content).map((part) => typeof part === "string" ? part : JSON.stringify(part)).join("\n");
    return {
      role,
      name,
      tool_call_id,
      content
    };
  }
  const contentParts = ensureArray(message.content).map(normalizeContentPart);
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return {
      role,
      name,
      content: contentParts[0].text
    };
  }
  return {
    role,
    name,
    content: contentParts
  };
};
var normalizeToolChoice = (toolChoice, tools) => {
  if (!toolChoice) return void 0;
  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }
  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }
    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }
    return {
      type: "function",
      function: { name: tools[0].function.name }
    };
  }
  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name }
    };
  }
  return toolChoice;
};
var resolveApiUrl = () => ENV.forgeApiUrl && ENV.forgeApiUrl.trim().length > 0 ? `${ENV.forgeApiUrl.replace(/\/$/, "")}/v1/chat/completions` : "https://forge.manus.im/v1/chat/completions";
var assertApiKey = () => {
  if (!ENV.forgeApiKey) {
    throw new Error("LLM API key is not configured. Please set LLM_API_KEY in your .env file.");
  }
};
var normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema
}) => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (explicitFormat.type === "json_schema" && !explicitFormat.json_schema?.schema) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }
  const schema = outputSchema || output_schema;
  if (!schema) return void 0;
  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }
  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...typeof schema.strict === "boolean" ? { strict: schema.strict } : {}
    }
  };
};
var RETRY_MAX_RETRIES = 4;
var RETRY_BASE_DELAY_MS = 500;
var RETRY_MAX_DELAY_MS = 3e4;
var LLM_REQUEST_TIMEOUT_MS = 45e3;
var sleep = (ms) => new Promise((resolve2) => setTimeout(resolve2, ms));
var parseRetryAfter = (value) => {
  if (!value) return void 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1e3);
  const at = Date.parse(value);
  return Number.isNaN(at) ? void 0 : Math.max(0, at - Date.now());
};
var computeBackoffDelay = (attempt, retryAfterMs) => {
  const cap = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  const jittered = cap / 2 + Math.random() * (cap / 2);
  return Math.min(Math.max(jittered, retryAfterMs ?? 0), RETRY_MAX_DELAY_MS);
};
var fetchWithBackoff = async (url, init) => {
  let lastError;
  const { signal: parentSignal, ...requestInit } = init;
  for (let attempt = 0; attempt <= RETRY_MAX_RETRIES; attempt++) {
    try {
      const attemptSignal = AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS);
      const signal = parentSignal ? AbortSignal.any([parentSignal, attemptSignal]) : attemptSignal;
      const response = await fetch(url, { ...requestInit, signal });
      if (response.ok || attempt === RETRY_MAX_RETRIES) {
        return response;
      }
      const retryAfterMs = parseRetryAfter(
        response.headers.get("retry-after")
      );
      try {
        await response.body?.cancel();
      } catch {
      }
      console.warn(
        `LLM request retry ${attempt + 1}/${RETRY_MAX_RETRIES} after status ${response.status}`
      );
      await sleep(computeBackoffDelay(attempt, retryAfterMs));
    } catch (error) {
      lastError = error;
      const errorName = error && typeof error === "object" && "name" in error ? String(error.name) : "";
      if (errorName === "TimeoutError") {
        if (attempt >= 1) throw new Error("The LLM request timed out after two bounded 45-second attempts.");
        console.warn("LLM request timed out; retrying once with a fresh request signal");
        await sleep(500);
        continue;
      }
      if (errorName === "AbortError" || parentSignal?.aborted) throw error;
      if (attempt === RETRY_MAX_RETRIES) throw error;
      console.warn(
        `LLM request retry ${attempt + 1}/${RETRY_MAX_RETRIES} after network error`
      );
      await sleep(computeBackoffDelay(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("LLM request failed after exhausting retries");
};
async function invokeLLM(params) {
  assertApiKey();
  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
    model,
    thinking,
    reasoning,
    maxTokens,
    max_tokens
  } = params;
  const payload = {
    messages: messages.map(normalizeMessage)
  };
  if (model) {
    payload.model = model;
  }
  if (tools && tools.length > 0) {
    payload.tools = tools;
  }
  const normalizedToolChoice = normalizeToolChoice(
    toolChoice || tool_choice,
    tools
  );
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }
  const resolvedMaxTokens = max_tokens ?? maxTokens;
  if (typeof resolvedMaxTokens === "number") {
    payload.max_tokens = resolvedMaxTokens;
  }
  if (thinking) {
    payload.thinking = thinking;
  }
  if (reasoning) {
    payload.reasoning = reasoning;
  }
  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema
  });
  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }
  const response = await fetchWithBackoff(resolveApiUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ENV.forgeApiKey}`
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `LLM invoke failed: ${response.status} ${response.statusText} \u2013 ${errorText}`
    );
  }
  return await response.json();
}
async function listLLMModels() {
  assertApiKey();
  const url = ENV.forgeApiUrl && ENV.forgeApiUrl.trim().length > 0 ? `${ENV.forgeApiUrl.replace(/\/$/, "")}/v1/models` : "https://forge.manus.im/v1/models";
  const response = await fetchWithBackoff(url, {
    headers: { authorization: `Bearer ${ENV.forgeApiKey}` }
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `List LLM models failed: ${response.status} ${response.statusText} \u2013 ${errorText}`
    );
  }
  return await response.json();
}

// server/research/llm.ts
var cachedModel = null;
var modelListPromise = null;
var builtinProvider = {
  name: "manus_builtin",
  async resolveModel() {
    if (process.env.LLM_MODEL?.trim()) return process.env.LLM_MODEL.trim();
    if (cachedModel) return cachedModel;
    if (!ENV.forgeApiKey && !process.env.LLM_API_KEY && !process.env.OPENAI_API_KEY) {
      throw new Error("No LLM API key configured. Please set OPENAI_API_KEY (or LLM_API_KEY) in your .env file.");
    }
    if (!modelListPromise) {
      modelListPromise = (async () => {
        const catalog = await listLLMModels();
        const models = Array.isArray(catalog.data) ? catalog.data : [];
        const chosen = models.find((model) => model.id === "gpt-5-mini") ?? models.find((model) => model.id === "gpt-5-nano") ?? models[0];
        if (!chosen?.id) throw new Error("No supported model is available from the configured built-in LLM provider.");
        cachedModel = chosen.id;
        return cachedModel;
      })().finally(() => {
        modelListPromise = null;
      });
    }
    return modelListPromise;
  },
  async completeStructured(input) {
    const response = await invokeLLM({
      model: input.model,
      messages: input.messages,
      response_format: { type: "json_schema", json_schema: { name: input.name, strict: true, schema: input.schema } }
    });
    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("The built-in LLM returned no structured output.");
    return content;
  }
};
var compatibleProvider = {
  name: "openai_compatible",
  async resolveModel() {
    const model = process.env.LLM_MODEL?.trim() || "openai/gpt-oss-120b";
    return model;
  },
  async completeStructured(input) {
    const base = (process.env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
    const apiKey = (process.env.LLM_API_KEY || process.env.OPENAI_API_KEY)?.trim();
    if (!apiKey) {
      throw new Error("No LLM API key configured. Please set LLM_API_KEY in your .env file.");
    }
    const endpoint = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    let maxTokens = 1200;
    if (input.name.includes("action") || input.name.includes("decision")) maxTokens = 350;
    else if (input.name.includes("plan")) maxTokens = 850;
    else if (input.name.includes("observation")) maxTokens = 850;
    else if (input.name.includes("verification")) maxTokens = 600;
    else if (input.name.includes("report") || input.name.includes("synthesis")) maxTokens = 2200;
    const tokenLimit = input.model.startsWith("gpt-5") || input.model.startsWith("o1") || input.model.startsWith("o3") ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };
    let activeModel = input.model;
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: activeModel,
            messages: input.messages,
            response_format: { type: "json_schema", json_schema: { name: input.name, strict: false, schema: input.schema } },
            ...tokenLimit
          }),
          signal: AbortSignal.timeout(25e3)
        });
        if (response.ok) {
          const payload = await response.json();
          const content = payload.choices?.[0]?.message?.content;
          if (typeof content !== "string") throw new Error("The compatible LLM returned no structured output.");
          return content;
        }
        const errBody = await response.text().catch(() => "");
        if (response.status === 429 && attempt < maxRetries) {
          const isDailyQuota = errBody.includes("tokens per day") || errBody.includes("TPD");
          if (isDailyQuota) {
            const nextModel = activeModel.includes("20b") ? "openai/gpt-oss-120b" : activeModel.includes("120b") ? "qwen/qwen3.8-27b" : "openai/gpt-oss-20b";
            console.warn(`[LLM] Model ${activeModel} reached daily quota. Switching to ${nextModel}...`);
            activeModel = nextModel;
            await new Promise((resolve2) => setTimeout(resolve2, 500));
            continue;
          }
          if (activeModel.includes("120b") && attempt === 0) {
            console.warn(`[LLM] Model ${activeModel} hit rate limit. Switching to openai/gpt-oss-20b...`);
            activeModel = "openai/gpt-oss-20b";
            await new Promise((resolve2) => setTimeout(resolve2, 500));
            continue;
          }
          const retryHeader = response.headers.get("retry-after");
          let delayMs = 2e3;
          if (retryHeader && Number.isFinite(Number(retryHeader))) {
            delayMs = Math.max(1, Number(retryHeader)) * 1e3;
          } else {
            const match = errBody.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
            if (match) {
              const minutes = match[1] ? parseFloat(match[1]) : 0;
              const seconds = match[2] ? parseFloat(match[2]) : 0;
              delayMs = Math.ceil((minutes * 60 + seconds) * 1e3) + 300;
            }
          }
          const cappedDelay = Math.min(delayMs, 4e3);
          console.warn(`[LLM] Rate limit reached. Backing off for ${cappedDelay}ms before retry (${attempt + 1}/${maxRetries})...`);
          await new Promise((resolve2) => setTimeout(resolve2, cappedDelay));
          continue;
        }
        if (response.status >= 500 && attempt < maxRetries) {
          const delayMs = 1500 * (attempt + 1);
          console.warn(`[LLM] Server returned ${response.status}. Retrying in ${delayMs}ms (${attempt + 1}/${maxRetries})...`);
          await new Promise((resolve2) => setTimeout(resolve2, delayMs));
          continue;
        }
        if (response.status === 400 && errBody.includes("tool_use_failed")) {
          try {
            const parsed = JSON.parse(errBody);
            const failedGen = parsed.error?.failed_generation;
            if (typeof failedGen === "string") {
              const toolCall = JSON.parse(failedGen);
              if (toolCall.name === "web_search" || toolCall.name === "search") {
                const query = toolCall.arguments?.query || toolCall.arguments?.q || "";
                console.log(`[LLM] Recovered tool call from failed_generation: search -> ${query}`);
                return JSON.stringify({
                  action: "search",
                  reason: "Execute search for relevant query",
                  expectedResult: "Relevant search results",
                  stepId: null,
                  query: query || null,
                  url: null,
                  expression: null,
                  replanFocus: null
                });
              }
              if (toolCall.name === "extract" || toolCall.name === "url_extractor") {
                const url = toolCall.arguments?.url || "";
                console.log(`[LLM] Recovered tool call from failed_generation: extract -> ${url}`);
                return JSON.stringify({
                  action: "extract",
                  reason: "Extract page content",
                  expectedResult: "Extracted source text",
                  stepId: null,
                  query: null,
                  url: url || null,
                  expression: null,
                  replanFocus: null
                });
              }
            }
          } catch {
          }
        }
        throw new Error(`Configured LLM returned HTTP ${response.status}: ${errBody || response.statusText}. Check provider configuration, model access, and structured-output support.`);
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("HTTP")) throw err;
        console.warn(`[LLM] Request failed (${msg}). Retrying in 2000ms...`);
        await new Promise((resolve2) => setTimeout(resolve2, 2e3));
      }
    }
    throw new Error("LLM request failed after exhausting all retry attempts.");
  }
};
function getLLMProvider() {
  const requested = process.env.LLM_PROVIDER?.trim().toLowerCase();
  const hasLocalKey = !!(process.env.LLM_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim());
  if (requested === "openai_compatible" || requested === "compatible") {
    return compatibleProvider;
  }
  if (requested === "manus_builtin" || requested === "builtin" || requested === "manus") {
    if (!ENV.forgeApiKey && hasLocalKey) {
      return compatibleProvider;
    }
    return builtinProvider;
  }
  if (hasLocalKey) {
    return compatibleProvider;
  }
  if (ENV.forgeApiKey) {
    return builtinProvider;
  }
  return compatibleProvider;
}
function parseStructuredContent(content) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
  }
  const start = trimmed.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quoted && char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, index + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new Error("The configured LLM returned non-JSON structured output.");
}
async function generateStructured(input) {
  const provider = getLLMProvider();
  const model = await provider.resolveModel();
  const request = {
    model,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user }
    ],
    schema: input.schema,
    name: input.promptName.replace(/[^a-z0-9_]/gi, "_").slice(0, 60)
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const content = await provider.completeStructured(request);
    try {
      return parseStructuredContent(content);
    } catch (error) {
      if (attempt === 1) throw error;
      console.warn("The LLM returned malformed structured JSON; retrying once with the same strict schema.");
    }
  }
  throw new Error("The configured LLM returned non-JSON structured output.");
}

// app/prompts/index.ts
var plannerPrompt = `You are ResearchPilot's planner. Convert the user's research goal into a compact, executable plan. You MUST output a JSON object containing a non-empty "steps" array with 2\u20134 concrete step objects, plus "objective" and "assumptions". Each step object MUST contain: id, title, objective, expectedInformation, completionCriteria, and preferredTool (one of: web_search, url_extractor, calculator, synthesis). Choose web_search for gathering external data and synthesis for final consolidation. Never invent facts or sources. Combine dependent subtasks when practical.`;
var decisionPrompt = `You are the action-selection engine inside a stateful research agent with a finite action budget. Inspect the actual current plan, completed steps, observations, sources and gaps, then choose ONE next action: search, extract, calculate, read_file, replan, verify, or finish. Complete each distinct plan step once; do not repeat a search with a near-identical query or chase source-count targets the user did not request. Search only for one unresolved question at a time. For search, return one concise natural-language query (not a list, semicolon-separated batch, or instructions to run multiple searches); preserve material region, audience, format and date constraints. Extract only a source already present in state. If the goal requests arithmetic, use the calculator before verification. Calculator input must be arithmetic only, as one safe expression or up to six semicolon-separated arithmetic equations with optional '= expected result' checks; include no prose outside the equations. Choose read_file only when an uploaded file exists and is relevant. Replan when new evidence changes scope or important gaps remain. Verify before finish. Do not claim a tool ran. Do NOT output tool/function call structures (such as {"name": ...}); you must strictly return a JSON object with "action" and "reason" matching the decision schema.`;
var observationPrompt = `You are the evidence analyst. Compare the just-completed real tool result with the current step and the user's constraints. You MUST output a complete JSON object matching the schema with ALL required fields: "summary" (what the tool found), "gaps" (array of concrete gaps or missing information), "stepComplete" (boolean: true if current step criteria are met, otherwise false), "nextMoveHint" (concise advice for next action), and "evidence" (array of claims supported by the text with claim, sourceId, supportingText, confidence, evidenceType). Cite source IDs exactly as provided, or use null. Never omit stepComplete, nextMoveHint, or evidence.`;
var replannerPrompt = `You are ResearchPilot's re-planner. Revise the remaining plan based on the original goal, existing plan, completed work, and newly observed evidence/gaps. Keep useful completed steps, add or sharpen only relevant unresolved steps, and explain why the plan changed. Do not invent findings or discard user constraints.`;
var verifierPrompt = `You are the final evidence verifier. Check the gathered findings against the original goal and the actual plan, sources, evidence and tool results. Identify unsupported factual claims, contradictions, and unlabelled uncertainty. PASS when the core factual claims are reasonably grounded in the supplied evidence and sources. Do not fail merely because exhaustive academic perfection or paywalled full-text retrieval was not achieved; mark PASS if solid evidence has been collected for the user's main question. Never add facts or sources.`;
var synthesisPrompt = `You are ResearchPilot's report writer. Answer the user's original goal using only the supplied evidence, tool results, calculations and explicit assumptions. Use clear sections: Executive summary, Findings, Evidence, Analysis, Calculations (when applicable), Risks and uncertainty, Recommended action plan. Cite only known source IDs such as [S1]. Label estimates, inferences and user-provided inputs. State what could not be verified. If verification status is FAIL, begin with a clear INCOMPLETE / NOT VERIFIED notice stating the verifier's missing information and required actions, but you MUST still write the complete, thorough report with all sections using all gathered evidence. Do not invent facts, source details, or URLs.`;

// server/research/store.ts
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { desc, eq as eq2 } from "drizzle-orm";
var require2 = createRequire(import.meta.url);
var sqlite = null;
var sqlitePath = null;
function useSQLite() {
  return process.env.RESEARCH_STORAGE === "sqlite" || !process.env.RESEARCH_STORAGE && !process.env.DATABASE_URL;
}
function getDbPath() {
  if (process.env.RESEARCH_DB_PATH) return resolve(process.env.RESEARCH_DB_PATH);
  if (process.env.VERCEL) return "/tmp/researchpilot.sqlite";
  return resolve("./data/researchpilot.sqlite");
}
function getSQLite() {
  const path = getDbPath();
  if (!sqlite || sqlitePath !== path) {
    if (sqlite) sqlite.close();
    mkdirSync(dirname(path), { recursive: true });
    const { DatabaseSync } = require2("node:sqlite");
    sqlite = new DatabaseSync(path);
    sqlitePath = path;
    sqlite.exec(`CREATE TABLE IF NOT EXISTS research_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      snapshot TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS research_sessions_updated ON research_sessions(updated_at DESC);`);
  }
  return sqlite;
}
async function saveSession(session) {
  const snapshot = JSON.stringify(session);
  if (useSQLite()) {
    getSQLite().prepare(`INSERT INTO research_sessions (id, goal, status, created_at, updated_at, snapshot)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET goal=excluded.goal, status=excluded.status,
      updated_at=excluded.updated_at, snapshot=excluded.snapshot`).run(session.id, session.goal, session.status, session.createdAt, session.updatedAt, snapshot);
    return;
  }
  const db = await getDb();
  if (!db) throw new Error("Session persistence is unavailable: DATABASE_URL is not configured or the database could not connect.");
  const values = {
    id: session.id,
    goal: session.goal,
    status: session.status,
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
    snapshot
  };
  await db.insert(researchSessions).values(values).onDuplicateKeyUpdate({ set: {
    goal: values.goal,
    status: values.status,
    updatedAt: values.updatedAt,
    snapshot: values.snapshot
  } });
}
function parseSnapshot(snapshot) {
  try {
    return JSON.parse(snapshot);
  } catch {
    return null;
  }
}
async function loadSession(id) {
  if (useSQLite()) {
    const row = getSQLite().prepare("SELECT snapshot FROM research_sessions WHERE id = ? LIMIT 1").get(id);
    return row?.snapshot ? parseSnapshot(row.snapshot) : null;
  }
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select({ snapshot: researchSessions.snapshot }).from(researchSessions).where(eq2(researchSessions.id, id)).limit(1);
  return rows[0] ? parseSnapshot(rows[0].snapshot) : null;
}
async function listSessions(limit = 30) {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  if (useSQLite()) {
    const rows2 = getSQLite().prepare("SELECT snapshot FROM research_sessions ORDER BY updated_at DESC LIMIT ?").all(safeLimit);
    return rows2.map((row) => parseSnapshot(row.snapshot)).filter((row) => row !== null);
  }
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ snapshot: researchSessions.snapshot }).from(researchSessions).orderBy(desc(researchSessions.updatedAt)).limit(safeLimit);
  return rows.map((row) => parseSnapshot(row.snapshot)).filter((row) => row !== null);
}

// server/research/engine.ts
var nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
var MAX_ACTION_TURNS = 12;
var planSchema = {
  type: "object",
  properties: {
    steps: { type: "array", minItems: 2, maxItems: 4, items: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        objective: { type: "string" },
        expectedInformation: { type: "string" },
        completionCriteria: { type: "string" },
        preferredTool: { type: "string", enum: ["web_search", "url_extractor", "calculator", "synthesis"] }
      },
      required: ["id", "title", "objective", "expectedInformation", "completionCriteria", "preferredTool"],
      additionalProperties: false
    } },
    objective: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } }
  },
  required: ["steps", "objective", "assumptions"],
  additionalProperties: false
};
var decisionSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["search", "extract", "calculate", "read_file", "replan", "verify", "finish"] },
    reason: { type: "string" },
    expectedResult: { type: "string" },
    stepId: nullableString,
    query: nullableString,
    url: nullableString,
    expression: nullableString,
    replanFocus: nullableString
  },
  required: ["action", "reason"],
  additionalProperties: false
};
var observationSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    gaps: { type: "array", items: { type: "string" } },
    stepComplete: { type: "boolean" },
    nextMoveHint: { type: "string" },
    evidence: { type: "array", items: { type: "object", properties: {
      claim: { type: "string" },
      sourceId: nullableString,
      supportingText: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      evidenceType: { type: "string", enum: ["direct", "calculated", "inferred", "estimate", "user_provided"] }
    }, required: ["claim", "supportingText"], additionalProperties: false } }
  },
  required: ["summary"],
  additionalProperties: false
};
var verificationSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["PASS", "FAIL"] },
    issues: { type: "array", items: { type: "string" } },
    unsupportedClaims: { type: "array", items: { type: "string" } },
    missingInformation: { type: "array", items: { type: "string" } },
    requiredActions: { type: "array", items: { type: "string" } }
  },
  required: ["status"],
  additionalProperties: false
};
function newMetrics() {
  return {
    startedAt: Date.now(),
    llmCalls: 0,
    toolCalls: 0,
    searches: 0,
    sourcesAnalyzed: 0,
    completedSteps: 0,
    replans: 0,
    verificationStatus: "PENDING",
    errors: 0,
    finalResponseLength: 0,
    iterations: 0
  };
}
function createResearchSession(goal, context = "") {
  const cleanGoal = goal.trim().replace(/\s+/g, " ").slice(0, 3e3);
  const now = Date.now();
  return {
    id: randomUUID(),
    goal: cleanGoal,
    status: "running",
    createdAt: now,
    updatedAt: now,
    plan: null,
    events: [],
    sources: [],
    evidence: [],
    toolCalls: [],
    decisions: [],
    errors: [],
    verification: null,
    report: "",
    metrics: newMetrics()
  };
}
function createDefaultSteps(goal) {
  return [
    {
      id: "step_1",
      title: "Investigate primary evidence and baseline metrics",
      objective: `Find core data points, costs, precedents, and facts relevant to: ${goal}`.slice(0, 600),
      expectedInformation: "Factual evidence, industry benchmarks, and authoritative data",
      completionCriteria: "Key evidence collected from authoritative sources",
      preferredTool: "web_search",
      status: "pending"
    },
    {
      id: "step_2",
      title: "Synthesize findings and assess feasibility",
      objective: `Evaluate trade-offs, aggregate gathered evidence, and verify conclusions for: ${goal}`.slice(0, 600),
      expectedInformation: "Clear, verifiable conclusions addressing the research goal",
      completionCriteria: "Comprehensive summary and verification complete",
      preferredTool: "synthesis",
      status: "pending"
    }
  ];
}
function validatePlan(candidate, fallbackGoal = "") {
  const rawSteps = Array.isArray(candidate?.steps) && candidate.steps.length > 0 ? candidate.steps : createDefaultSteps(fallbackGoal);
  const slicedSteps = rawSteps.slice(0, 4);
  if (slicedSteps.length === 1) {
    slicedSteps.push({
      id: "step_2",
      title: "Synthesize findings",
      objective: "Consolidate and verify evidence",
      expectedInformation: "Comprehensive summary",
      completionCriteria: "Key questions answered",
      preferredTool: "synthesis",
      status: "pending"
    });
  }
  const seenIds = /* @__PURE__ */ new Set();
  const steps = slicedSteps.map((step, index) => {
    let id = String(step.id || `step_${index + 1}`).slice(0, 40);
    if (seenIds.has(id)) {
      id = `${id}_${index + 1}`;
    }
    seenIds.add(id);
    return {
      id,
      title: String(step.title || `Step ${index + 1}`).slice(0, 160),
      objective: String(step.objective || "").slice(0, 600),
      expectedInformation: String(step.expectedInformation || "").slice(0, 300),
      completionCriteria: String(step.completionCriteria || "").slice(0, 300),
      preferredTool: step.preferredTool || "web_search",
      status: "pending"
    };
  });
  return {
    objective: String(candidate?.objective || `Investigate: ${fallbackGoal}`).slice(0, 500),
    assumptions: Array.isArray(candidate?.assumptions) && candidate.assumptions.length > 0 ? candidate.assumptions.map(String).slice(0, 10) : ["Initial evidence should be gathered from primary authoritative sources"],
    steps
  };
}
function stepFor(session, stepId) {
  if (!session.plan) return null;
  if (stepId) {
    const requested = session.plan.steps.find((step) => step.id === stepId);
    if (requested && requested.preferredTool !== "synthesis") return requested;
  }
  return session.plan.steps.find((step) => step.status !== "completed" && step.preferredTool !== "synthesis") ?? null;
}
function pendingEvidenceSteps(session) {
  return session.plan?.steps.filter((step) => step.status !== "completed" && step.preferredTool !== "synthesis") ?? [];
}
function toolRecord(session, record) {
  session.toolCalls.push({ ...record, id: randomUUID(), timestamp: Date.now() });
  session.metrics.toolCalls += 1;
}
function contextSnapshot(session) {
  return JSON.stringify({
    goal: session.goal,
    plan: session.plan,
    completedSteps: session.plan?.steps.filter((step) => step.status === "completed").map((step) => ({ id: step.id, title: step.title })) ?? [],
    observations: session.events.filter((event) => event.stage === "observation").slice(-3).map((event) => event.message?.slice(0, 200)),
    sources: session.sources.slice(-4).map((source) => ({ id: source.id, title: source.title?.slice(0, 80), url: source.url, snippet: source.snippet?.slice(0, 150) })),
    evidence: session.evidence.slice(-6).map((e) => ({ id: e.id, claim: e.claim?.slice(0, 120), sourceId: e.sourceId })),
    tools: session.toolCalls.slice(-3).map((t2) => ({ tool: t2.tool, success: !t2.error })),
    decisions: session.decisions.slice(-3).map((d) => ({ action: d.action, reason: d.reason?.slice(0, 80) })),
    errors: session.errors.slice(-2)
  });
}
async function runResearch(session, sink, options = {}) {
  let persistenceWarningSent = false;
  let latestObservation = "No observations yet.";
  let forcedReplan = false;
  let verificationCycles = 0;
  const persist = async () => {
    session.updatedAt = Date.now();
    try {
      await saveSession(session);
    } catch (error) {
      session.metrics.errors += 1;
      const message = error instanceof Error ? error.message : "Unknown database error";
      if (!persistenceWarningSent) {
        persistenceWarningSent = true;
        session.errors.push(message);
      }
    }
  };
  const emit = async (stage, title, message, details, tool) => {
    const event = { id: session.events.length + 1, timestamp: Date.now(), stage, title, message, ...details ? { details } : {}, ...tool ? { tool } : {} };
    session.events.push(event);
    session.updatedAt = event.timestamp;
    await persist();
    sink(event);
  };
  const structured = async (input) => {
    session.metrics.llmCalls += 1;
    return generateStructured(input);
  };
  try {
    await emit("planner", "Planner \xB7 decomposing the question", "The planning model is converting the fresh research goal into testable subtasks.", { goal: session.goal });
    let plan;
    try {
      const candidatePlan = await structured({
        promptName: "research_plan",
        system: plannerPrompt,
        user: JSON.stringify({ goal: session.goal, context: options.context ?? "", uploadedFile: options.file ? { name: options.file.name, characters: options.file.content.length } : null }),
        schema: planSchema
      });
      plan = validatePlan(candidatePlan, session.goal);
    } catch (planError) {
      console.warn("[Research Engine] Planner generation failed; using goal-aligned fallback plan:", planError);
      plan = validatePlan(null, session.goal);
    }
    session.plan = plan;
    await emit("planner", "Plan committed", `${session.plan.steps.length} subtasks generated; each includes completion criteria and a preferred tool.`, { plan: session.plan });
    let turn = 0;
    let finished = false;
    while (!finished && turn < MAX_ACTION_TURNS) {
      turn += 1;
      session.metrics.iterations = turn;
      const pending = pendingEvidenceSteps(session);
      if (!pending.length && !session.verification) {
        await emit("decision", "Decision \xB7 all planned evidence gathered", "The state evaluator found every plan step complete; it is routing to verification.", { action: "verify", basis: "All required plan steps completed" });
        session.decisions.push({ action: "verify", reason: "All required plan steps completed", timestamp: Date.now() });
        await verifyAndContinue();
        if (session.verification?.status === "PASS") finished = await synthesize();
        continue;
      }
      if (!pending.length && session.verification?.status === "PASS") {
        finished = await synthesize();
        continue;
      }
      await new Promise((resolve2) => setTimeout(resolve2, 1500));
      const decision = await structured({
        promptName: "next_agent_action",
        system: decisionPrompt,
        user: JSON.stringify({ state: contextSnapshot(session), latestObservation, forcedReplan, fileAvailable: Boolean(options.file), fileName: options.file?.name ?? null, remainingTurns: MAX_ACTION_TURNS - turn }),
        schema: decisionSchema
      });
      let rawAction = String(decision?.action || "").toLowerCase().trim();
      if (rawAction === "web_search" || rawAction === "websearch") rawAction = "search";
      if (rawAction === "url_extractor" || rawAction === "extractor") rawAction = "extract";
      if (rawAction === "calculator") rawAction = "calculate";
      if (rawAction === "synthesis" || rawAction === "synthesize") rawAction = "finish";
      if (rawAction === "verification") rawAction = "verify";
      if (!["search", "extract", "calculate", "read_file", "replan", "verify", "finish"].includes(rawAction)) {
        if (decision?.query) rawAction = "search";
        else if (decision?.url) rawAction = "extract";
        else rawAction = pending.length ? "search" : "verify";
      }
      decision.action = rawAction;
      if (!decision.reason) decision.reason = `Proceeding with ${rawAction}`;
      const step = stepFor(session, decision.stepId);
      const effectiveAction = forcedReplan && session.metrics.replans < 3 ? "replan" : decision.action;
      forcedReplan = false;
      session.decisions.push({ action: effectiveAction, reason: (decision.reason || "").slice(0, 800), timestamp: Date.now() });
      await emit("decision", `Decision \xB7 ${effectiveAction.replace("_", " ")}`, decision.reason, { action: effectiveAction, stepId: step?.id ?? null, expectedResult: decision.expectedResult });
      if (effectiveAction === "replan") {
        if (session.metrics.replans >= 3) {
          await emit("decision", "Re-plan limit reached", "The agent retained its current plan to prevent an unbounded workflow.", { maxReplans: 3 });
          if (step) step.status = "in_progress";
          continue;
        }
        const previous = session.plan;
        const newPlan = await structured({
          promptName: "revised_research_plan",
          system: replannerPrompt,
          user: JSON.stringify({ goal: session.goal, previousPlan: previous, state: contextSnapshot(session), focus: decision.replanFocus ?? latestObservation }),
          schema: { ...planSchema, properties: { ...planSchema.properties, reason: { type: "string" } }, required: [...planSchema.required, "reason"] }
        });
        const revised = validatePlan(newPlan, session.goal);
        for (const nextStep of revised.steps) {
          const oldDone = previous?.steps.find((old) => old.status === "completed" && old.objective.toLowerCase() === nextStep.objective.toLowerCase());
          if (oldDone) nextStep.status = "completed";
        }
        session.plan = revised;
        session.metrics.replans += 1;
        await emit("replan", "Plan updated \xB7 evidence changed the route", newPlan.reason || decision.reason, { previousPlan: previous, updatedPlan: revised, trigger: latestObservation });
        continue;
      }
      if (effectiveAction === "verify") {
        await verifyAndContinue();
        if (session.verification?.status === "PASS") finished = await synthesize();
        continue;
      }
      if (effectiveAction === "finish") {
        if (session.verification?.status !== "PASS") {
          await emit("decision", "Finish deferred \xB7 verification is mandatory", "The orchestrator rejected a premature finish request and is routing the actual evidence to verification.", { rejectedAction: "finish", requiredNextAction: "verify" });
          await verifyAndContinue();
          if (session.verification?.status === "PASS") finished = await synthesize();
        } else finished = await synthesize();
        continue;
      }
      if (!step) {
        await emit("observation", "Observation \xB7 no open plan step", "No open subtask was available; the state loop will re-evaluate the plan.", { pendingSteps: 0 });
        forcedReplan = true;
        continue;
      }
      step.status = "in_progress";
      let toolName = "";
      let toolInput = {};
      let toolOutput = "";
      let observationExtra = {};
      let usedSources = [];
      let toolOk = true;
      try {
        if (effectiveAction === "search") {
          toolName = "web_search";
          const suggestedQuery = (decision.query || step.objective || step.expectedInformation).slice(0, 1200);
          const query = normalizeSearchQuery(suggestedQuery);
          toolInput = { query, suggestedQuery, maxResults: 5 };
          await emit("tool_execution", "Tool \xB7 live web search", `Searching DuckDuckGo for: ${query}`, { query, provider: "DuckDuckGo HTML Search", resultLimit: 5 }, "web_search");
          const results = await webSearch(query, 5);
          usedSources = normalizeSearchRecords(results.map((result) => ({ ...result, snippet: result.snippet })), Date.now());
          for (const source of usedSources) source.id = `S${session.sources.length + 1 + usedSources.indexOf(source)}`;
          const known = new Set(session.sources.map((source) => source.url));
          usedSources = usedSources.filter((source) => !known.has(source.url));
          session.sources.push(...usedSources);
          session.metrics.searches += 1;
          session.metrics.sourcesAnalyzed = session.sources.length;
          toolOutput = JSON.stringify(usedSources.map((source) => ({ id: source.id, title: source.title, url: source.url, snippet: source.snippet })));
          observationExtra = { sourceIds: usedSources.map((source) => source.id), resultCount: usedSources.length };
        } else if (effectiveAction === "extract") {
          toolName = "url_extractor";
          const target = (decision.url || "").trim().toLowerCase();
          const source = session.sources.find(
            (item) => item.url.toLowerCase() === target || item.id.toLowerCase() === target || item.url.toLowerCase().replace(/\/$/, "") === target.replace(/\/$/, "") || target && item.url.toLowerCase().includes(target)
          ) || session.sources.find((item) => !item.extractedText) || session.sources[0];
          if (!source) throw new Error("URL extraction requires a URL already discovered by the live search tool.");
          toolInput = { url: source.url, sourceId: source.id };
          await emit("tool_execution", "Tool \xB7 extracting a cited source", `Fetching readable evidence from ${source.domain}.`, { sourceId: source.id, url: source.url }, "url_extractor");
          const page = await extractPage(source.url);
          source.title = page.title || source.title;
          source.extractedText = page.text;
          observationExtra = { sourceId: source.id, charactersExtracted: page.text.length };
          toolOutput = JSON.stringify({ sourceId: source.id, title: source.title, url: source.url, text: page.text.slice(0, 5500) });
        } else if (effectiveAction === "calculate") {
          toolName = "calculator";
          const expression = (decision.expression || "").slice(0, 900);
          toolInput = { expression };
          await emit("tool_execution", "Tool \xB7 deterministic calculator", `Evaluating the validated expression: ${expression || "(empty)"}`, { expression }, "calculator");
          const calculations = calculateBatch(expression);
          observationExtra = { expression, calculations };
          toolOutput = JSON.stringify({ expression, calculations });
          for (const calculation of calculations) {
            session.evidence.push({ id: randomUUID(), claim: `${calculation.expression} = ${calculation.result}`, supportingText: `Executed by the deterministic arithmetic parser: ${calculation.expression} = ${calculation.result}.`, confidence: 1, evidenceType: "calculated" });
          }
        } else if (effectiveAction === "read_file") {
          toolName = "file_reader";
          if (!options.file) throw new Error("No supported user file was attached to this research run.");
          toolInput = { name: options.file.name, characters: options.file.content.length };
          await emit("tool_execution", "Tool \xB7 user file reader", `Inspecting ${options.file.name} (${options.file.content.length.toLocaleString()} characters).`, { fileName: options.file.name }, "file_reader");
          const result = readUserFile(options.file.name, options.file.content);
          observationExtra = { fileName: result.name, characters: result.characters };
          toolOutput = JSON.stringify({ ...result, preview: result.preview.slice(0, 8e3) });
        }
      } catch (error) {
        toolOk = false;
        session.metrics.errors += 1;
        const message = error instanceof Error ? error.message : "The tool failed unexpectedly.";
        session.errors.push(`${toolName || effectiveAction}: ${message}`);
        observationExtra = { error: message, partialEvidenceAvailable: session.sources.length > 0 || session.evidence.length > 0 };
        toolOutput = JSON.stringify({ error: message });
        await emit("error", `${toolName || effectiveAction} \xB7 tool error`, `${message} The agent will keep prior evidence and choose its next action from the surviving state.`, observationExtra, toolName || void 0);
      }
      toolRecord(session, { tool: toolName || effectiveAction, input: toolInput, outputSummary: toolOutput.slice(0, 1500), ok: toolOk });
      session.metrics.completedSteps = session.plan?.steps.filter((item) => item.status === "completed").length ?? 0;
      const observation = await structured({
        promptName: "tool_observation",
        system: observationPrompt,
        user: JSON.stringify({ goal: session.goal, step, tool: toolName, toolResult: toolOutput.slice(0, 2e3), priorEvidence: session.evidence.slice(-6).map((e) => ({ id: e.id, claim: e.claim?.slice(0, 150) })), sources: usedSources.map((source) => ({ id: source.id, url: source.url, title: source.title })), toolError: toolOk ? null : observationExtra.error }),
        schema: observationSchema
      });
      latestObservation = observation.summary;
      for (const item of observation.evidence || []) {
        if (item.sourceId && !session.sources.some((source) => source.id === item.sourceId)) continue;
        const { sourceId, ...evidenceItem } = item;
        session.evidence.push({
          ...evidenceItem,
          ...sourceId ? { sourceId } : {},
          id: randomUUID(),
          confidence: Math.max(0, Math.min(item.confidence ?? 0.8, 1)),
          evidenceType: item.evidenceType || "direct"
        });
      }
      if (observation.stepComplete && toolOk) step.status = "completed";
      session.metrics.completedSteps = session.plan?.steps.filter((item) => item.status === "completed").length ?? 0;
      const gaps = observation.gaps || [];
      await emit("observation", "Observation \xB7 state updated", observation.summary, { stepId: step.id, stepComplete: step.status === "completed", gaps, nextMoveHint: observation.nextMoveHint || "", ...observationExtra });
      if (gaps.length && /mismatch|does not match|irrelevant|wrong audience|wrong region|not comparable|scope changed|constraint/i.test(`${observation.summary} ${gaps.join(" ")}`)) {
        forcedReplan = session.metrics.replans < 3;
      }
    }
    if (!session.report) {
      if (session.verification?.status !== "PASS") {
        await emit("verification", "Verification \xB7 final bounded review", "The autonomous loop reached its safety limit. A final check records missing evidence rather than implying it passed.", { iterationLimit: MAX_ACTION_TURNS });
        session.verification = {
          status: "FAIL",
          issues: ["The agent reached its maximum action count before verification passed."],
          unsupportedClaims: [],
          missingInformation: pendingEvidenceSteps(session).map((step) => step.expectedInformation),
          requiredActions: ["Run another focused research cycle."]
        };
        session.metrics.verificationStatus = "FAIL";
      }
      await synthesize();
    }
    session.status = "completed";
    session.metrics.completedAt = Date.now();
    session.metrics.durationMs = session.metrics.completedAt - session.metrics.startedAt;
    session.metrics.finalResponseLength = session.report.length;
    await emit("final_report", "Final report \xB7 research run complete", "The final report was synthesized from this run's actual sources, tool results, and verification outcome.", { verification: session.verification?.status, reportCharacters: session.report.length, metrics: session.metrics, report: session.report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The research workflow failed unexpectedly.";
    session.status = "failed";
    session.errors.push(message);
    session.metrics.errors += 1;
    session.metrics.completedAt = Date.now();
    session.metrics.durationMs = session.metrics.completedAt - session.metrics.startedAt;
    await emit("error", "Research run failed safely", message, { retryable: true });
  }
  return session;
  async function verifyAndContinue() {
    verificationCycles += 1;
    await emit("verification", "Verification \xB7 checking the actual evidence", "The verifier is auditing completeness, source support, relevance, consistency, calculations, and uncertainty before any final response.", { cycle: verificationCycles, sourceCount: session.sources.length, evidenceCount: session.evidence.length });
    const result = await structured({
      promptName: "evidence_verification",
      system: verifierPrompt,
      user: JSON.stringify({ goal: session.goal, plan: session.plan, reportDraft: session.report || null, sources: session.sources.slice(-8).map((source) => ({ id: source.id, title: source.title?.slice(0, 100), url: source.url, snippet: source.snippet?.slice(0, 200), extractedText: source.extractedText?.slice(0, 400) })), evidence: session.evidence.slice(-12), toolCalls: session.toolCalls.slice(-5), previousVerification: session.verification }),
      schema: verificationSchema
    });
    const unfinished = pendingEvidenceSteps(session);
    const issues = [...result.issues];
    const requiredActions = [...result.requiredActions];
    let status = result.status;
    if (unfinished.length) {
      status = "FAIL";
      issues.push(`${unfinished.length} required plan step(s) remain incomplete.`);
      requiredActions.push(...unfinished.map((step) => `Research: ${step.expectedInformation}`));
    }
    if (!session.sources.length && session.evidence.every((item) => item.evidenceType !== "calculated" && item.evidenceType !== "user_provided")) {
      status = "FAIL";
      issues.push("No independently retrieved source supports this report.");
      requiredActions.push("Search for primary sources or clearly report that web research was unavailable.");
    }
    session.verification = { ...result, status, issues: Array.from(new Set(issues)), requiredActions: Array.from(new Set(requiredActions)) };
    session.metrics.verificationStatus = status;
    await emit("verification", `Verification \xB7 ${status}`, status === "PASS" ? "The evidence and completed plan passed the current verification checks." : "Verification identified gaps. The agent will re-plan and continue rather than returning an unverified report.", { ...session.verification });
    if (status === "FAIL" && verificationCycles <= 2 && session.metrics.replans < 3) {
      session.verification = null;
      forcedReplan = true;
      await emit("replan", "Plan update triggered by verification", "Verification failure is being fed back into the live planner; the next decision will target its specific required actions.", { previousResult: result, focusedActions: Array.from(new Set(requiredActions)) });
    }
  }
  async function synthesize() {
    if (!session.verification) return false;
    session.metrics.llmCalls += 1;
    const response = await generateStructured({
      promptName: "evidence_report",
      system: synthesisPrompt,
      user: JSON.stringify({ goal: session.goal, plan: session.plan, evidence: session.evidence.slice(-12).map((e) => ({ id: e.id, claim: e.claim, sourceId: e.sourceId, confidence: e.confidence, evidenceType: e.evidenceType })), sources: session.sources.slice(-8).map((source) => ({ id: source.id, title: source.title?.slice(0, 100), url: source.url, domain: source.domain, snippet: source.snippet?.slice(0, 200), extractedText: source.extractedText?.slice(0, 500) })), calculations: session.toolCalls.filter((tool) => tool.tool === "calculator").slice(-3), verification: session.verification, limitations: session.errors.slice(-3) }),
      schema: { type: "object", properties: { report: { type: "string" } }, required: ["report"], additionalProperties: false }
    });
    const report = response.report.trim();
    if (!report) throw new Error("The report writer returned an empty response.");
    session.report = report.slice(0, 3e4);
    for (const step of session.plan?.steps ?? []) {
      if (step.preferredTool === "synthesis") step.status = "completed";
    }
    session.metrics.completedSteps = session.plan?.steps.filter((step) => step.status === "completed").length ?? 0;
    return true;
  }
}

// server/research/runtime.ts
var sessions = /* @__PURE__ */ new Map();
var active = /* @__PURE__ */ new Set();
var listeners = /* @__PURE__ */ new Map();
var runOptions = /* @__PURE__ */ new Map();
async function startResearchRun(goal, options = {}) {
  const session = createResearchSession(goal, options.context);
  sessions.set(session.id, session);
  runOptions.set(session.id, options);
  active.add(session.id);
  try {
    await saveSession(session);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Session storage unavailable.";
    session.errors.push(message);
  }
  void runResearch(session, (event) => {
    sessions.set(session.id, session);
    Array.from(listeners.get(session.id) ?? []).forEach((listener) => listener(event));
  }, options).then((result) => {
    sessions.set(result.id, result);
  }).finally(() => {
    active.delete(session.id);
  });
  return session;
}
function ensureResearchRunning(sessionId, onEvent, fallbackGoal) {
  let session = sessions.get(sessionId);
  if (!session && fallbackGoal) {
    session = createResearchSession(fallbackGoal);
    session.id = sessionId;
    sessions.set(sessionId, session);
  }
  if (!session) return null;
  if (session.status !== "running") return Promise.resolve(session);
  if (active.has(sessionId)) return null;
  active.add(sessionId);
  const options = runOptions.get(sessionId) || {};
  return runResearch(session, (event) => {
    sessions.set(session.id, session);
    if (onEvent) onEvent(event);
    Array.from(listeners.get(sessionId) ?? []).forEach((listener) => listener(event));
  }, options).then((result) => {
    sessions.set(result.id, result);
    return result;
  }).finally(() => {
    active.delete(sessionId);
  });
}
async function getResearchSession(id) {
  const inMemory = sessions.get(id);
  if (inMemory) return inMemory;
  const stored = await loadSession(id);
  if (stored?.status === "running") {
    if (Date.now() - stored.updatedAt > 3e5) {
      return markInterrupted(stored);
    }
  }
  return stored;
}
async function getResearchHistory(limit = 30) {
  const stored = await listSessions(limit);
  for (const session of stored) {
    if (session.status === "running" && !sessions.has(session.id) && Date.now() - session.updatedAt > 3e5) {
      await markInterrupted(session);
    }
  }
  const merged = new Map(stored.map((session) => [session.id, session]));
  Array.from(sessions.values()).forEach((session) => merged.set(session.id, session));
  return Array.from(merged.values()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
function isResearchActive(id) {
  return active.has(id);
}
function subscribeToResearch(id, listener) {
  const set = listeners.get(id) ?? /* @__PURE__ */ new Set();
  set.add(listener);
  listeners.set(id, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(id);
  };
}
async function markInterrupted(session) {
  if (session.status !== "running") return session;
  const message = "The server process restarted before this run finished. Start a new run to resume the research with a fresh live session.";
  session.status = "failed";
  session.updatedAt = Date.now();
  session.metrics.completedAt = session.updatedAt;
  session.metrics.durationMs = session.updatedAt - session.metrics.startedAt;
  session.metrics.errors += 1;
  session.errors.push(message);
  session.events.push({
    id: session.events.length + 1,
    timestamp: session.updatedAt,
    stage: "error",
    title: "Run interrupted by server restart",
    message,
    details: { recoverable: true }
  });
  sessions.set(session.id, session);
  try {
    await saveSession(session);
  } catch {
  }
  return session;
}

// server/research/router.ts
var uploadSchema = z2.object({
  name: z2.string().min(1).max(180),
  content: z2.string().max(8e4)
}).optional();
var researchRouter = router({
  start: publicProcedure.input(z2.object({
    goal: z2.string().trim().min(12, "Please provide a research question with enough detail.").max(3e3),
    context: z2.string().max(1500).optional(),
    file: uploadSchema
  })).mutation(async ({ input }) => {
    return startResearchRun(input.goal, { context: input.context, file: input.file });
  }),
  get: publicProcedure.input(z2.object({ id: z2.string().uuid() })).query(async ({ input }) => {
    const session = await getResearchSession(input.id);
    if (!session) throw new Error("Research session not found.");
    return session;
  }),
  history: publicProcedure.input(z2.object({ limit: z2.number().int().min(1).max(100).default(30) }).optional()).query(async ({ input }) => {
    return (await getResearchHistory(input?.limit ?? 30)).map((session) => ({
      id: session.id,
      goal: session.goal,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      eventCount: session.events.length,
      sourceCount: session.sources.length,
      toolCount: session.toolCalls.length,
      verificationStatus: session.metrics.verificationStatus,
      durationMs: session.metrics.durationMs
    }));
  }),
  sources: publicProcedure.input(z2.object({ id: z2.string().uuid() })).query(async ({ input }) => {
    const session = await getResearchSession(input.id);
    if (!session) throw new Error("Research session not found.");
    return session.sources;
  })
});

// server/routers.ts
var appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true };
    })
  }),
  research: researchRouter
});

// server/_core/context.ts
async function createContext(opts) {
  let user = null;
  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    user = null;
  }
  return {
    req: opts.req,
    res: opts.res,
    user
  };
}

// server/_core/app.ts
function createExpressApp() {
  const app2 = express();
  app2.use(express.json({ limit: "50mb" }));
  app2.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app2);
  registerOAuthRoutes(app2);
  app2.get("/api/research/:id/events", async (req, res) => {
    const sessionId = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
      res.status(400).json({ error: "Invalid research session id." });
      return;
    }
    const after = Number(req.get("Last-Event-ID") ?? req.query.after ?? 0);
    let lastSent = Number.isFinite(after) ? after : 0;
    const buffered = [];
    let ready = false;
    let closed = false;
    const send = (event) => {
      if (closed || event.id <= lastSent) return;
      lastSent = event.id;
      res.write(`id: ${event.id}
event: agent_event
data: ${JSON.stringify(event)}

`);
    };
    const unsubscribe = subscribeToResearch(sessionId, (event) => {
      if (ready) send(event);
      else buffered.push(event);
    });
    res.status(200);
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write("retry: 1500\n\n");
    try {
      let session = await getResearchSession(sessionId);
      const fallbackGoal = typeof req.query.goal === "string" ? req.query.goal.trim() : "";
      if (!session && fallbackGoal) {
        ensureResearchRunning(sessionId, send, fallbackGoal);
        session = await getResearchSession(sessionId);
      }
      if (!session) {
        res.write(`event: stream_error
data: ${JSON.stringify({ error: "Research session not found." })}

`);
        closed = true;
        unsubscribe();
        res.end();
        return;
      }
      session.events.forEach(send);
      ready = true;
      buffered.sort((a, b) => a.id - b.id).forEach(send);
      if (session.status === "running") {
        ensureResearchRunning(sessionId, send, fallbackGoal || session.goal);
      } else if (!isResearchActive(sessionId)) {
        res.write("event: stream_complete\ndata: {}\n\n");
        closed = true;
        unsubscribe();
        res.end();
        return;
      }
      const heartbeat = setInterval(() => {
        if (!closed) res.write(": keepalive\n\n");
      }, 15e3);
      req.on("close", () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      });
    } catch {
      closed = true;
      unsubscribe();
      res.end();
    }
  });
  app2.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext
    })
  );
  return app2;
}
var app = createExpressApp();
var app_default = app;
export {
  app,
  createExpressApp,
  app_default as default
};
