import type { D1Database } from "@cloudflare/workers-types";

export interface WorkerEnv {
  DB: D1Database;
  SESSION_SECRET: string;
  CORS_ORIGINS: string;
  SESSION_COOKIE_SAME_SITE: "lax" | "strict" | "none";
  SESSION_COOKIE_SECURE: string;
}

export interface WorkerRequest {
  params: Record<string, string>;
  body: Record<string, unknown>;
  ip: string;
  session: {
    userId?: string;
    regenerate(callback: (error?: Error) => void): void;
    destroy(callback?: (error?: Error) => void): void;
  };
  env: WorkerEnv;
}

export interface WorkerResponse {
  status(code: number): this;
  json(value: unknown): this;
  end(): this;
  clearCookie(name: string): this;
}

type NextFunction = (error?: unknown) => void;
type Handler = (request: WorkerRequest, response: WorkerResponse, next: NextFunction) => unknown;
type Route = { method: string; pattern: RegExp; keys: string[]; handlers: Handler[] };
type SessionData = { userId?: string; cookie?: Record<string, unknown> };

const COOKIE_NAME = "availability.sid";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function randomId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, "");
}

function equal(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

async function readSessionId(request: Request, secret: string): Promise<string | null> {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookie = cookieHeader.split(";").map(value => value.trim()).find(value => value.startsWith(`${COOKIE_NAME}=`));
  if (!cookie) return null;
  let value: string;
  try {
    value = decodeURIComponent(cookie.slice(COOKIE_NAME.length + 1));
  } catch {
    return null;
  }
  if (!value.startsWith("s:")) return null;
  const separator = value.lastIndexOf(".");
  if (separator < 3) return null;
  const sid = value.slice(2, separator);
  return equal(value.slice(separator + 1), await hmac(secret, sid)) ? sid : null;
}

class ResponseBuilder implements WorkerResponse {
  statusCode = 200;
  body: string | null = null;
  headers = new Headers();
  clearSessionCookie = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(value: unknown): this {
    this.headers.set("Content-Type", "application/json; charset=utf-8");
    this.body = JSON.stringify(value);
    return this;
  }

  end(): this {
    this.body = null;
    return this;
  }

  clearCookie(name: string): this {
    if (name === COOKIE_NAME) this.clearSessionCookie = true;
    return this;
  }
}

function routePattern(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const parts = path.split("/").map(part => {
    if (part.startsWith(":")) {
      keys.push(part.slice(1));
      return "([^/]+)";
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { pattern: new RegExp(`^${parts.join("/")}/?$`), keys };
}

export class WorkerApp {
  private readonly routes: Route[] = [];

  get(path: string, ...handlers: Handler[]): void { this.add("GET", path, handlers); }
  post(path: string, ...handlers: Handler[]): void { this.add("POST", path, handlers); }
  put(path: string, ...handlers: Handler[]): void { this.add("PUT", path, handlers); }
  patch(path: string, ...handlers: Handler[]): void { this.add("PATCH", path, handlers); }
  delete(path: string, ...handlers: Handler[]): void { this.add("DELETE", path, handlers); }

  private add(method: string, path: string, handlers: Handler[]): void {
    this.routes.push({ method, ...routePattern(path), handlers });
  }

  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const origin = request.headers.get("Origin");
    const allowedOrigins = new Set(env.CORS_ORIGINS.split(",").map(value => value.trim()).filter(Boolean));
    if (origin && !allowedOrigins.has(origin)) return Response.json({ error: "Origin is not allowed." }, { status: 403 });

    const corsHeaders = new Headers({ Vary: "Origin" });
    if (origin) {
      corsHeaders.set("Access-Control-Allow-Origin", origin);
      corsHeaders.set("Access-Control-Allow-Credentials", "true");
    }
    if (request.method === "OPTIONS") {
      corsHeaders.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      corsHeaders.set("Access-Control-Allow-Headers", "Content-Type");
      corsHeaders.set("Access-Control-Max-Age", "86400");
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    let body: Record<string, unknown> = {};
    if (request.method !== "GET" && request.method !== "HEAD") {
      const rawBody = await request.text();
      if (encoder.encode(rawBody).byteLength > 100 * 1024) {
        return Response.json({ error: "Request body is too large." }, { status: 413, headers: corsHeaders });
      }
      if (rawBody) {
        try {
          const parsed: unknown = JSON.parse(rawBody);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Expected a JSON object.");
          body = parsed as Record<string, unknown>;
        } catch {
          return Response.json({ error: "Request body must be a JSON object." }, { status: 400, headers: corsHeaders });
        }
      }
    }

    const url = new URL(request.url);
    const route = this.routes.find(candidate => candidate.method === request.method && candidate.pattern.test(url.pathname));
    if (!route) return Response.json({ error: "Not found." }, { status: 404, headers: corsHeaders });
    const match = route.pattern.exec(url.pathname);
    if (!match) return Response.json({ error: "Not found." }, { status: 404, headers: corsHeaders });
    const params: Record<string, string> = {};
    try {
      route.keys.forEach((key, index) => { params[key] = decodeURIComponent(match[index + 1]); });
    } catch {
      return Response.json({ error: "Invalid URL parameter." }, { status: 400, headers: corsHeaders });
    }

    const originalSid = await readSessionId(request, env.SESSION_SECRET);
    let sid = originalSid;
    let storedSession: SessionData = {};
    if (sid) {
      const stored = await env.DB.prepare('SELECT "sess", "expire" FROM "user_sessions" WHERE "sid" = ?1').bind(sid).first<{ sess: string; expire: string }>();
      if (stored && Date.parse(stored.expire) > Date.now()) {
        const parsed: unknown = JSON.parse(stored.sess);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Stored session data is invalid.");
        storedSession = parsed as SessionData;
      } else if (stored) {
        await env.DB.prepare('DELETE FROM "user_sessions" WHERE "sid" = ?1').bind(sid).run();
        sid = null;
      }
    }
    const session: SessionData = { ...storedSession };
    let sessionDestroyed = false;
    const sessionApi = session as WorkerRequest["session"];
    Object.defineProperties(sessionApi, {
      regenerate: {
        enumerable: false,
        value: (callback: (error?: Error) => void) => {
          const previousSid = sid;
          sid = randomId();
          for (const key of Object.keys(session)) delete session[key as keyof SessionData];
          sessionDestroyed = false;
          const remove = previousSid
            ? env.DB.prepare('DELETE FROM "user_sessions" WHERE "sid" = ?1').bind(previousSid).run()
            : Promise.resolve();
          void remove.then(() => callback()).catch(error => callback(error instanceof Error ? error : new Error(String(error))));
        }
      },
      destroy: {
        enumerable: false,
        value: (callback?: (error?: Error) => void) => {
          const previousSid = sid;
          sid = null;
          sessionDestroyed = true;
          for (const key of Object.keys(session)) delete session[key as keyof SessionData];
          const remove = previousSid
            ? env.DB.prepare('DELETE FROM "user_sessions" WHERE "sid" = ?1').bind(previousSid).run()
            : Promise.resolve();
          void remove.then(() => callback?.()).catch(error => callback?.(error instanceof Error ? error : new Error(String(error))));
        }
      }
    });
    const apiRequest: WorkerRequest = {
      params,
      body,
      ip: request.headers.get("CF-Connecting-IP") || "unknown",
      session: sessionApi,
      env
    };
    const apiResponse = new ResponseBuilder();

    try {
      let position = 0;
      const invoke = async (): Promise<void> => {
        if (position >= route.handlers.length || apiResponse.body !== null || apiResponse.statusCode === 204) return;
        const handler = route.handlers[position++];
        let nextCalled = false;
        let nextError: unknown;
        await handler(apiRequest, apiResponse, error => {
          if (error !== undefined) nextError = error;
          else nextCalled = true;
        });
        if (nextError !== undefined) throw nextError;
        if (nextCalled) await invoke();
      };
      await invoke();
    } catch (error) {
      console.error("Worker request failed", error);
      apiResponse.status(500).json({ error: "An unexpected server error occurred." });
    }

    const now = Date.now();
    if (sessionDestroyed || !session.userId) {
      if (originalSid && !sessionDestroyed) await env.DB.prepare('DELETE FROM "user_sessions" WHERE "sid" = ?1').bind(originalSid).run();
    } else if (session.userId) {
      sid ||= randomId();
      const expires = new Date(now + SESSION_MAX_AGE);
      session.cookie = {
        ...session.cookie,
        originalMaxAge: SESSION_MAX_AGE,
        expires: expires.toISOString(),
        httpOnly: true,
        path: "/",
        sameSite: env.SESSION_COOKIE_SAME_SITE,
        secure: env.SESSION_COOKIE_SECURE === "true"
      };
      await env.DB.prepare(
        'INSERT INTO "user_sessions" ("sid", "sess", "expire") VALUES (?1, ?2, ?3) ON CONFLICT("sid") DO UPDATE SET "sess" = excluded."sess", "expire" = excluded."expire"'
      ).bind(sid, JSON.stringify(session), expires.toISOString()).run();
      const signed = `s:${sid}.${await hmac(env.SESSION_SECRET, sid)}`;
      const sameSite = env.SESSION_COOKIE_SAME_SITE[0].toUpperCase() + env.SESSION_COOKIE_SAME_SITE.slice(1);
      corsHeaders.append("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(signed)}; Path=/; Expires=${expires.toUTCString()}; HttpOnly; SameSite=${sameSite}${env.SESSION_COOKIE_SECURE === "true" ? "; Secure" : ""}`);
    }
    if (apiResponse.clearSessionCookie) {
      corsHeaders.append("Set-Cookie", `${COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=${env.SESSION_COOKIE_SAME_SITE}${env.SESSION_COOKIE_SECURE === "true" ? "; Secure" : ""}`);
    }
    apiResponse.headers.forEach((value, key) => corsHeaders.set(key, value));
    return new Response(apiResponse.body, { status: apiResponse.statusCode, headers: corsHeaders });
  }
}

export function rateLimit(limit: number, windowMs: number): Handler {
  return async (request, response, next) => {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(request.ip));
    const identifier = `${limit}:${windowMs}:${toBase64Url(new Uint8Array(digest))}`;
    const now = Date.now();
    const result = await request.env.DB.prepare(
      'INSERT INTO "WorkerRateLimit" ("identifier", "count", "resetAt") VALUES (?1, 1, ?2) ON CONFLICT("identifier") DO UPDATE SET "count" = CASE WHEN "resetAt" <= ?3 THEN 1 ELSE "count" + 1 END, "resetAt" = CASE WHEN "resetAt" <= ?3 THEN ?2 ELSE "resetAt" END RETURNING "count"'
    ).bind(identifier, now + windowMs, now).first<{ count: number }>();
    if (!result || result.count > limit) {
      response.status(429).json({ error: "Too many requests. Please try again later." });
      return;
    }
    next();
  };
}
