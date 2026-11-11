import { createCipheriv, randomInt } from "node:crypto";
import { z } from "zod";
import { IDS_BASE_URL, IDS_PATHS } from "./ids";

const NeedCaptchaJson = z.object({ isNeed: z.boolean().optional() });

/**
 * Server-side IDS password login (Wisedu 统一身份认证, Apereo CAS wire protocol).
 *
 * Verified against the live deployment on 2026-11-11:
 *
 *   GET  /authserver/login?service=<svc>      → HTML with #pwdEncryptSalt (16 chars),
 *                                               #execution, #lt, #cllt, #dllt
 *   GET  /authserver/checkNeedCaptcha.htl?username=<u>&_=<ts> → {"isNeed":bool}
 *   GET  /authserver/getCaptcha.htl?_=<ts>    → JPEG, bound to JSESSIONID
 *   POST /authserver/login?service=<svc>
 *        username, password=<encryptPassword(pwd,salt)>, captcha, _eventId=submit,
 *        cllt=userNameLogin, dllt=generalLogin, lt, execution
 *   → 302 <svc>?ticket=ST-...   (plus Set-Cookie: CASTGC on ids host)
 *   → 302 /authserver/login...  on failure
 *
 * Password cipher (byte-exact port of /authserver/customTheme2/static/common/encrypt.js):
 *   AES-128-CBC, key = utf8(salt16), iv = utf8(randomString(16)),
 *   plaintext = utf8(randomString(64) + password), PKCS#7, base64 output.
 *
 * Two traps handled here:
 *   - `Set-Cookie` is malformed (`...; Path=/authserver; secure; SameSite=None; Secure; HttpOnly`
 *     plus a value-less `Max-Age=0;path=/authserver/; HttpOnly; Secure`). Real cookie jars drop
 *     JSESSIONID, so cookies are captured from raw headers and sent explicitly.
 *   - Captcha escalates per egress IP, not per account. Callers must never retry blindly.
 */

const AES_CHARS = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";
const LOGIN_PATH = IDS_PATHS.login;

export type CookieJar = Record<string, string>;

function randomString(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += AES_CHARS.charAt(randomInt(AES_CHARS.length));
  return out;
}

/** Port of the site's `encryptPassword(password, pwdEncryptSalt)`. */
export function encryptPassword(password: string, salt: string): string {
  const trimmed = salt.replace(/^\s+|\s+$/g, "");
  const key = Buffer.from(trimmed, "utf8");
  if (key.length !== 16) throw new Error(`unexpected IDS salt length: ${key.length}`);
  const iv = Buffer.from(randomString(16), "utf8");
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const plain = Buffer.from(randomString(64) + password, "utf8");
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64");
}

function absorbCookies(res: Response, jar: CookieJar): void {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0]?.trim() ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || value === "") continue;
    jar[name] = value;
  }
}

function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function hiddenValue(html: string, id: string): string | undefined {
  const tag = html.match(new RegExp(`<input[^>]*\\bid=["']${id}["'][^>]*>`, "i"))?.[0];
  if (!tag) return undefined;
  return tag.match(/\bvalue=["']([^"']*)["']/i)?.[1];
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: string;
  contentType?: string;
  referer?: string;
  jar: CookieJar;
}

async function request(url: string, opts: RequestOptions): Promise<{ res: Response; text: string }> {
  const headers: Record<string, string> = {
    accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  };
  if (opts.referer) headers.referer = opts.referer;
  if (Object.keys(opts.jar).length > 0) headers.cookie = cookieHeader(opts.jar);
  if (opts.body !== undefined) headers["content-type"] = opts.contentType ?? "application/x-www-form-urlencoded";

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body,
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  absorbCookies(res, opts.jar);
  const text = await res.text();
  return { res, text };
}

function locationOf(res: Response, base: string): string | undefined {
  const raw = res.headers.get("location");
  if (!raw) return undefined;
  try {
    return new URL(raw, base).toString();
  } catch {
    return undefined;
  }
}

/** Known IDS failure strings, mapped to stable codes so tools can act on them. */
const FAILURE_MESSAGES: Array<{ match: RegExp; code: string; message: string }> = [
  { match: /用户名或密码有误|密码有误|非常用账号/, code: "bad_credentials", message: "用户名或密码错误" },
  { match: /验证码/, code: "captcha_invalid", message: "验证码错误或已过期" },
  { match: /会话已失效|请重新登录/, code: "session_expired", message: "登录会话已失效，请重新发起登录" },
  { match: /账号.*(锁定|冻结|禁用)|已锁定/, code: "account_locked", message: "账号已被锁定或禁用" },
];

function failureFromHtml(html: string): { code: string; message: string } {
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  for (const f of FAILURE_MESSAGES) {
    if (f.match.test(visible)) return { code: f.code, message: f.message };
  }
  return { code: "login_failed", message: "登录失败（IDS 未说明原因）" };
}

export interface LoginInput {
  username: string;
  password: string;
  captcha?: string;
  /** Service to obtain a ticket for; defaults to the IDS personal center. */
  service?: string;
  /** Cookies from a previous `captcha_required` result. */
  jar?: CookieJar;
}

export type LoginOutcome =
  | { kind: "ok"; userId: string; cookies: CookieJar; service: string; ticket?: string }
  | {
      kind: "captcha_required";
      cookies: CookieJar;
      service: string;
      captcha: { mimeType: string; data: string };
    }
  | { kind: "failed"; code: string; message: string; cookies: CookieJar };

const DEFAULT_SERVICE = `${IDS_BASE_URL}/authserver/index.do`;

export async function login(input: LoginInput): Promise<LoginOutcome> {
  const service = input.service ?? DEFAULT_SERVICE;
  const jar: CookieJar = { ...(input.jar ?? {}) };

  const loginUrl = `${IDS_BASE_URL}${LOGIN_PATH}?service=${encodeURIComponent(service)}`;
  const page = await request(loginUrl, { jar });
  if (page.res.status !== 200) {
    return { kind: "failed", code: "ids_unavailable", message: `IDS 登录页返回 HTTP ${page.res.status}`, cookies: jar };
  }

  const salt = hiddenValue(page.text, "pwdEncryptSalt");
  const execution = hiddenValue(page.text, "execution");
  if (!salt || !execution) {
    return { kind: "failed", code: "page_changed", message: "IDS 登录页结构变化：缺 pwdEncryptSalt 或 execution", cookies: jar };
  }
  const lt = hiddenValue(page.text, "lt") ?? "";

  const needCaptchaRes = await request(
    `${IDS_BASE_URL}/authserver/checkNeedCaptcha.htl?username=${encodeURIComponent(input.username)}&_=${Date.now()}`,
    { jar, referer: loginUrl },
  );
  let needCaptcha = false;
  try {
    const parsed = NeedCaptchaJson.safeParse(JSON.parse(needCaptchaRes.text));
    needCaptcha = parsed.success && parsed.data.isNeed === true;
  } catch {
    // Treat an unparsable answer as "no captcha"; the POST will tell us otherwise.
  }

  if (needCaptcha && !input.captcha) {
    const capUrl = `${IDS_BASE_URL}/authserver/getCaptcha.htl?_=${Date.now()}`;
    const cap = await fetch(capUrl, {
      headers: { cookie: cookieHeader(jar), referer: loginUrl, accept: "image/*" },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    absorbCookies(cap, jar);
    if (!cap.ok) {
      return { kind: "failed", code: "captcha_unavailable", message: `无法获取验证码（HTTP ${cap.status}）`, cookies: jar };
    }
    const bytes = Buffer.from(await cap.arrayBuffer());
    return {
      kind: "captcha_required",
      cookies: jar,
      service,
      captcha: { mimeType: cap.headers.get("content-type") ?? "image/jpeg", data: bytes.toString("base64") },
    };
  }

  const form = new URLSearchParams({
    username: input.username,
    password: encryptPassword(input.password, salt),
    captcha: input.captcha ?? "",
    _eventId: "submit",
    cllt: "userNameLogin",
    dllt: "generalLogin",
    lt,
    execution,
  });

  const posted = await request(loginUrl, {
    method: "POST",
    body: form.toString(),
    referer: loginUrl,
    jar,
  });

  const redirect = locationOf(posted.res, loginUrl);
  const successLocation = redirect?.includes("ticket=") ? redirect : undefined;
  const bodyTicket = posted.text.match(/\bticket=(ST-[^"'&\s]+)/)?.[1];

  if (successLocation || bodyTicket) {
    return {
      kind: "ok",
      userId: input.username,
      cookies: jar,
      service,
      ticket: successLocation ? new URL(successLocation).searchParams.get("ticket") ?? undefined : bodyTicket,
    };
  }

  // Failure: IDS bounces back to the login page, which carries the message.
  let errorHtml = posted.text;
  if (redirect && !redirect.includes("ticket=")) {
    const follow = await request(redirect, { jar, referer: loginUrl });
    errorHtml = follow.text;
  }
  return { kind: "failed", ...failureFromHtml(errorHtml), cookies: jar };
}

/**
 * Mint a service ticket from an existing CASTGC session. Returns the redirect
 * URL when the session is still alive, null when IDS wants a fresh login.
 */
export async function mintServiceTicket(cookies: CookieJar, service: string): Promise<string | null> {
  const res = await fetch(`${IDS_BASE_URL}${LOGIN_PATH}?service=${encodeURIComponent(service)}`, {
    headers: { cookie: cookieHeader(cookies), accept: "text/html" },
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const location = locationOf(res, IDS_BASE_URL);
  if (res.status >= 300 && res.status < 400 && location?.includes("ticket=")) return location;
  return null;
}

export { cookieHeader };
