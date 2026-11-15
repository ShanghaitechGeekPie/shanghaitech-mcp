import { createHash } from "node:crypto";
import { login } from "./ids-auth";
import { getRoot, putRoot, sessionHandle } from "./session-store";

/**
 * Credential-backed campus sessions.
 *
 * When a client sends the IDS username/password as its bearer credential, the
 * server mints the CASTGC itself and stores it under a per-user key, so the
 * password is never persisted and the client never has to call `ids_login`.
 * The upstream TGT still expires on IDS's schedule — what changes is that the
 * server can re-login silently instead of asking the user again.
 *
 * The per-user key depends only on the username, so repeated calls reuse one
 * TGT instead of piling up logins (IDS risk control is keyed to the egress IP).
 */

export class CredentialLoginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CredentialLoginError";
  }
}

/** Stable, non-reversible store key; the password never reaches Redis. */
export function credentialSessionId(username: string): string {
  const digest = createHash("sha256").update(username.trim().toLowerCase()).digest("base64url");
  return `cred-${digest.slice(0, 24)}`;
}

const inflight = new Map<string, Promise<string>>();

/** Returns a sealed MCP session handle for these credentials, logging in only when needed. */
export async function sessionForCredentials(username: string, password: string): Promise<string> {
  const user = username.trim();
  const sid = credentialSessionId(user);
  const handle = sessionHandle(sid);

  if (await getRoot(sid)) return handle;

  const pending = inflight.get(sid);
  if (pending) return pending;

  const attempt = (async () => {
    const outcome = await login({ username: user, password, lang: "zh_CN" });
    if (outcome.kind === "ok") {
      await putRoot(sid, { userId: outcome.userId, cookies: outcome.cookies });
      return handle;
    }
    if (outcome.kind === "captcha_required") {
      throw new CredentialLoginError(
        "captcha_required",
        "IDS 要求验证码（风控），无法在无交互的凭据登录里完成。请先用 ids_login 带 captcha 登录一次，之后 12 小时内可直接用凭据访问。",
      );
    }
    throw new CredentialLoginError(
      outcome.code || "bad_credentials",
      `IDS 登录失败（${outcome.code || "bad_credentials"}）：${outcome.message}`,
    );
  })().finally(() => {
    inflight.delete(sid);
  });

  inflight.set(sid, attempt);
  return attempt;
}
