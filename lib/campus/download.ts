import { BB_BASE } from "./elearning";
import { ELRC_BASE } from "./elrc";
import type { CookieJar } from "./http";
import { seal, unseal } from "./seal";

interface DownloadPayload {
  jar: CookieJar;
  path: string;
  name: string;
  /** Which upstream host the path belongs to. */
  base?: string;
}

const ALLOWED: Array<{ base: string; prefixes: string[] }> = [
  { base: BB_BASE, prefixes: ["/bbcswebdav/"] },
  { base: ELRC_BASE, prefixes: ["/bucket-"] },
];

/** Blackboard course files sit behind a session cookie; mint a short-lived proxy link. */
export function downloadUrl(origin: string, jar: CookieJar, path: string, name: string, base?: string): string {
  const token = seal({ jar, path, name, base }, 10 * 60 * 1000);
  return `${origin.replace(/\/+$/, "")}/api/download?t=${encodeURIComponent(token)}`;
}

export async function proxyDownload(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t");
  if (!token) return new Response("missing token", { status: 400 });

  let payload: DownloadPayload;
  try {
    payload = unseal<DownloadPayload>(token);
  } catch (cause) {
    return new Response(`invalid token: ${(cause as Error).message}`, { status: 403 });
  }
  const route = ALLOWED.find((a) => a.base === (payload.base ?? BB_BASE) && a.prefixes.some((p) => payload.path.startsWith(p)));
  if (!route) return new Response("bad path", { status: 400 });

  const upstream = await fetch(`${route.base}${payload.path}`, {
    headers: {
      "user-agent": "Mozilla/5.0",
      cookie: Object.entries(payload.jar ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    },
    redirect: "follow",
    signal: AbortSignal.timeout(45_000),
  });
  if (!upstream.ok) return new Response(`upstream HTTP ${upstream.status}`, { status: 502 });

  const headers = new Headers();
  headers.set("content-type", upstream.headers.get("content-type") ?? "application/octet-stream");
  const len = upstream.headers.get("content-length");
  if (len) headers.set("content-length", len);
  headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(payload.name)}`);
  headers.set("cache-control", "private, max-age=0, no-store");
  return new Response(upstream.body, { headers });
}
