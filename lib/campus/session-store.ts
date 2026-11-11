import { Redis } from "@upstash/redis";
import { randomBytes } from "node:crypto";
import { deriveEcourseSession } from "./ecourse";
import { deriveEamsSession } from "./eams";
import { deriveEgateSession } from "./egate";
import { deriveBlackboardSession } from "./elearning";
import { type AuthContext, type CookieJar } from "./http";
import { libspaceSession } from "./libspace";
import { seal, unseal } from "./seal";
import { CampusSessionExpired } from "./eams";

/**
 * Two-level campus session store.
 *
 *   root    : IDS login material (CASTGC + ids cookies), TTL 12h
 *   derived : one entry per platform (cookies or `token:` header), TTL 30min
 *
 * Derived entries are re-minted from the root when missing, so a burst of
 * requests across edge instances hits each platform's SSO chain once instead of
 * once per call. When the root itself is gone the only fix is `ids_login`.
 *
 * Storage is Upstash Redis (REST, edge-compatible). Without `UPSTASH_*` (or
 * Vercel KV `KV_REST_API_*`) credentials, an in-process map is used so local
 * development works; that fallback is per-instance and never load-bearing.
 *
 * Values are sealed with `MCP_ENC_KEY` as well, so a Redis dump alone does not
 * hand out campus sessions.
 */

export const ROOT_TTL_SEC = 12 * 60 * 60;
export const DERIVED_TTL_SEC = 30 * 60;

export type PlatformKey = "eams" | "egate" | "ecourse" | "libspace" | "elearning";

const DERIVERS: Record<PlatformKey, (root: CookieJar) => Promise<AuthContext>> = {
  eams: deriveEamsSession,
  egate: deriveEgateSession,
  ecourse: deriveEcourseSession,
  libspace: libspaceSession,
  elearning: deriveBlackboardSession,
};

export interface RootSession {
  userId: string;
  cookies: CookieJar;
}

export interface SessionInfo {
  userId: string;
  rootExpiresAt: number;
  derived: Partial<Record<PlatformKey, number>>;
}

// ---------------------------------------------------------------- backend

const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const redis = url && token ? new Redis({ url, token }) : null;

if (!redis && process.env.NODE_ENV === "production") {
  console.warn("[session] UPSTASH_REDIS_REST_URL/TOKEN missing — using per-instance memory; edge caching will be ineffective");
}

const memory = new Map<string, { value: string; exp: number }>();

async function getRaw(key: string): Promise<string | null> {
  if (redis) {
    const value = await redis.get<string>(key);
    return value ?? null;
  }
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) {
    memory.delete(key);
    return null;
  }
  return hit.value;
}

async function setRaw(key: string, value: string, ttlSec: number): Promise<void> {
  if (redis) {
    await redis.set(key, value, { ex: ttlSec });
    return;
  }
  memory.set(key, { value, exp: Date.now() + ttlSec * 1000 });
}

async function delRaw(key: string): Promise<void> {
  if (redis) await redis.del(key);
  else memory.delete(key);
}

const rootKey = (sid: string) => `st:${sid}:root`;
const derivedKey = (sid: string, platform: PlatformKey) => `st:${sid}:d:${platform}`;

function sealedValue<T extends object>(value: T, ttlSec: number): string {
  return seal(value, ttlSec * 1000);
}

function openValue<T extends object>(raw: string): T {
  return unseal<T>(raw);
}

// ---------------------------------------------------------------- API

export function newSessionId(): string {
  return randomBytes(18).toString("base64url");
}

/** Opaque handle given to the MCP client; it only carries the store key. */
export function sessionHandle(sid: string): string {
  return seal({ sid }, ROOT_TTL_SEC * 1000);
}

function handleSessionId(handle: string): string {
  try {
    return unseal<{ sid: string }>(handle).sid;
  } catch {
    throw new CampusSessionExpired("session 句柄无效或已过期，请重新 ids_login");
  }
}

export async function putRoot(sid: string, root: RootSession): Promise<void> {
  await setRaw(rootKey(sid), sealedValue(root, ROOT_TTL_SEC), ROOT_TTL_SEC);
}

export async function getRoot(sid: string): Promise<RootSession | null> {
  const raw = await getRaw(rootKey(sid));
  return raw ? openValue<RootSession>(raw) : null;
}

export async function putDerived(sid: string, platform: PlatformKey, auth: AuthContext): Promise<void> {
  await setRaw(derivedKey(sid, platform), sealedValue(auth, DERIVED_TTL_SEC), DERIVED_TTL_SEC);
}

export async function getDerived(sid: string, platform: PlatformKey): Promise<AuthContext | null> {
  const raw = await getRaw(derivedKey(sid, platform));
  return raw ? openValue<AuthContext>(raw) : null;
}

export async function dropDerived(sid: string, platform: PlatformKey): Promise<void> {
  await delRaw(derivedKey(sid, platform));
}

export async function sessionInfo(handle: string): Promise<SessionInfo | null> {
  const sid = handleSessionId(handle);
  const root = await getRoot(sid);
  if (!root) return null;
  const derived: Partial<Record<PlatformKey, number>> = {};
  for (const platform of Object.keys(DERIVERS) as PlatformKey[]) {
    const hit = await getRaw(derivedKey(sid, platform));
    if (!hit) continue;
    try {
      derived[platform] = unseal<{ exp: number }>(hit).exp;
    } catch {
      // expired between calls; ignore
    }
  }
  return { userId: root.userId, rootExpiresAt: Date.now() + ROOT_TTL_SEC * 1000, derived };
}

/**
 * Resolve a platform session: cached derived entry → mint from root → store.
 * Root missing means the user must log in again.
 */
export async function platformAuth(handle: string, platform: PlatformKey): Promise<AuthContext> {
  const sid = handleSessionId(handle);
  const cached = await getDerived(sid, platform);
  if (cached) return cached;

  const root = await getRoot(sid);
  if (!root) throw new CampusSessionExpired("会话已过期（ticket 失效），请重新 ids_login");

  const auth = await DERIVERS[platform](root.cookies);
  await putDerived(sid, platform, auth);
  return auth;
}
