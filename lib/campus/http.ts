/**
 * Cookie handling shared by every campus client.
 *
 * Campus hosts emit `Set-Cookie` that Node's cookie parsers mishandle (IDS sends
 * `...; secure; SameSite=None; Secure; HttpOnly` plus a value-less cookie), so
 * cookies are captured from raw headers into a plain record and replayed
 * explicitly. Nothing here persists anything.
 */

export type CookieJar = Record<string, string>;

const COOKIE_NAME = /^[A-Za-z0-9_.-]+$/;

export function absorbCookies(res: Response, jar: CookieJar): void {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0]?.trim() ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!COOKIE_NAME.test(name) || value === "") continue;
    jar[name] = value;
  }
}

export function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export interface FollowOptions {
  jar?: CookieJar;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  /** Maximum redirect hops; campus SSO chains need 4–8. */
  maxHops?: number;
  timeoutMs?: number;
}

export interface FollowResult {
  status: number;
  url: string;
  text: string;
  jar: CookieJar;
  redirects: string[];
}

/**
 * Follow redirects manually so every hop's `Set-Cookie` lands in the jar.
 * A POST turns into GET after the first 3xx, matching browser behaviour.
 */
export async function follow(startUrl: string, opts: FollowOptions = {}): Promise<FollowResult> {
  const jar: CookieJar = { ...(opts.jar ?? {}) };
  const maxHops = opts.maxHops ?? 8;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const redirects: string[] = [];

  let url = startUrl;
  let method = opts.method ?? "GET";
  let body = opts.body;

  for (let hop = 0; hop <= maxHops; hop++) {
    const headers: Record<string, string> = {
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/126.0.0.0 Safari/537.36",
      ...opts.headers,
    };
    if (Object.keys(jar).length > 0) headers.cookie = cookieHeader(jar);
    if (body !== undefined) headers["content-type"] ??= "application/x-www-form-urlencoded";

    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    absorbCookies(res, jar);

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location && hop < maxHops) {
      const next = new URL(location, url).toString();
      if (!next.startsWith("http")) throw new Error(`refusing non-HTTP redirect to ${next}`);
      redirects.push(next);
      url = next;
      method = "GET";
      body = undefined;
      await res.body?.cancel();
      continue;
    }

    return { status: res.status, url, text: await res.text(), jar, redirects };
  }

  throw new Error(`too many redirects from ${startUrl}`);
}
