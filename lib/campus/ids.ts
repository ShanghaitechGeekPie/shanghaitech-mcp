/**
 * ShanghaiTech IDS (统一身份认证) helpers.
 *
 * IDS is a Wisedu 统一身份认证平台 that speaks the Apereo CAS 1.0/2.0/3.0 wire
 * protocol under /authserver/*. It is not vanilla CAS and has no OIDC
 * discovery, so every endpoint below is hard-coded to a verified path.
 *
 * Flow used by this project:
 *   1. browser → /authserver/login?service=<our callback>  (user types credentials)
 *   2. IDS → 302 <callback>?ticket=ST-...
 *   3. server → /authserver/p3/serviceValidate?service=...&ticket=...&format=JSON
 *
 * Password login from a serverless function is deliberately NOT implemented:
 * IDS escalates captcha by egress IP, supports SMS/FIDO/QR login, and flags
 * unfamiliar ASNs. Never collect campus passwords.
 */

export const IDS_BASE_URL = (process.env.IDS_BASE_URL ?? "https://ids.shanghaitech.edu.cn").replace(/\/+$/, "");

export const IDS_PATHS = {
  login: "/authserver/login",
  validate: "/authserver/validate",
  serviceValidate: "/authserver/serviceValidate",
  p3ServiceValidate: "/authserver/p3/serviceValidate",
  logout: "/authserver/logout",
} as const;

/** CAS login URL for the given service. `service` must be the exact callback URL we later validate. */
export function idsLoginUrl(service: string): string {
  return `${IDS_BASE_URL}${IDS_PATHS.login}?service=${encodeURIComponent(service)}`;
}

export interface CasAuthentication {
  /** 学号 / 工号 */
  user: string;
  attributes: Record<string, string[] | string>;
}

interface P3SuccessBody {
  serviceResponse?: {
    authenticationSuccess?: {
      user?: string;
      attributes?: Record<string, string[] | string>;
    };
    authenticationFailure?: { code?: string; description?: string };
  };
}

/**
 * Redeem a service ticket server-to-server.
 * Returns null for an invalid/expired ticket; throws on transport or protocol errors.
 */
export async function validateServiceTicket(
  service: string,
  ticket: string,
  signal?: AbortSignal,
): Promise<CasAuthentication | null> {
  const url = `${IDS_BASE_URL}${IDS_PATHS.p3ServiceValidate}?service=${encodeURIComponent(service)}&ticket=${encodeURIComponent(ticket)}&format=JSON`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: signal ?? AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`IDS serviceValidate returned HTTP ${res.status}`);

  const text = await res.text();
  let body: P3SuccessBody;
  try {
    body = JSON.parse(text) as P3SuccessBody;
  } catch {
    throw new Error(`IDS serviceValidate returned non-JSON payload: ${text.slice(0, 200)}`);
  }

  const response = body.serviceResponse;
  if (response?.authenticationFailure) return null;
  const success = response?.authenticationSuccess;
  if (!success?.user) return null;

  return { user: success.user, attributes: success.attributes ?? {} };
}
