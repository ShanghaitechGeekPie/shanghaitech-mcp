import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Sealed session handles.
 *
 * Serverless functions cannot keep per-user state in memory, and this project
 * deliberately avoids a database, so state travels with the caller: the MCP
 * tool returns an opaque `v1.<iv>.<ct>` string and later calls pass it back.
 *
 * AES-256-GCM, AAD binds the token to this purpose; expiry is inside the
 * plaintext so a stolen token dies quickly. Treat the handle like a password:
 * it carries CASTGC session cookies.
 */

const AAD = Buffer.from("shanghaitech-mcp/session/v1", "utf8");
const VERSION = "v1";

function key(): Buffer {
  const raw = process.env.MCP_ENC_KEY?.trim();
  if (!raw) {
    throw new Error("MCP_ENC_KEY is not set (generate with: openssl rand -base64 32)");
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("MCP_ENC_KEY must be 32 bytes of base64");
  return buf;
}

export interface SealedPayload {
  exp: number;
}

export function seal<T extends object>(payload: T, ttlMs: number): string {
  const body = JSON.stringify({ ...payload, exp: Date.now() + ttlMs });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function unseal<T extends object>(token: string): T & SealedPayload {
  const parts = token.trim().split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("invalid session handle");
  const [, ivB64, tagB64, ctB64] = parts;
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("invalid session handle");

  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64url"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const plain = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");

  const parsed = JSON.parse(plain) as T & SealedPayload;
  if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) throw new Error("session handle expired");
  return parsed;
}
