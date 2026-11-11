import { proxyDownload } from "@/lib/campus/download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Sealed, 10-minute, cookie-gated file proxy (see lib/campus/download.ts). */
export async function GET(request: Request): Promise<Response> {
  return proxyDownload(request);
}
