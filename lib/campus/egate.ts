import { z } from "zod";
import { follow, type CookieJar } from "./http";
import { CampusSessionExpired } from "./eams";

/**
 * egate-app (xshdapp) adapter — the activity check-in module.
 *
 * Same CASTGC chain as EAMS but it lands behind Apache `mod_auth_cas`, so the
 * session cookies are `MOD_AUTH_CAS` + `_WEU` instead of `JSESSIONID`.
 *
 * Ported from `shanghaitech-cpdaily-auth/lib/egate-app/egate-app.ts` (the
 * TechPie backend's `POST /auth/third-party/egate-app {tgc}` path).
 */

export const EGATE_BASE = (process.env.EGATE_BASE_URL ?? "https://egate.shanghaitech.edu.cn").replace(/\/+$/, "");

const SIGN_MESSAGE_URL = `${EGATE_BASE}/xsfw/sys/xshdapp/xshdApply/dxnxxqgrhz.do`;
const APP_CONFIG_URL = `${EGATE_BASE}/xsfw/sys/funauthapp/api/getAppConfig/xshdapp-4770201649822494.do`;
const STUDENT_INFO_URL = `${EGATE_BASE}/xsfw/sys/jbxxapp/modules/jbxx/hqdlxsjpcxx.do`;

const EgStudentResponse = z.object({
  code: z.union([z.string(), z.number()]),
  datas: z
    .object({
      hqdlxsjpcxx: z
        .object({
          rows: z.array(
            z.object({ XSBH: z.string().optional(), XM: z.string().optional() }).catchall(z.unknown()),
          ),
        })
        .optional(),
    })
    .optional(),
});

function assertAlive(url: string, text: string): void {
  if (url.includes("ids.shanghaitech.edu.cn") || text.includes("统一身份认证")) {
    throw new CampusSessionExpired("CASTGC 已失效，请重新 ids_login");
  }
}

export async function deriveEgateSession(root: CookieJar): Promise<CookieJar> {
  const entry = await follow(SIGN_MESSAGE_URL, { jar: root, maxHops: 8 });
  assertAlive(entry.url, entry.text);
  if (!entry.jar.MOD_AUTH_CAS) {
    throw new CampusSessionExpired("egate-app 未下发 MOD_AUTH_CAS cookie（CASTGC 无效？）");
  }
  return entry.jar;
}

/** The app-config preflight is side-effect-free and keeps MOD_AUTH_CAS/_WEU current. */
export async function egateStudent(cookies: CookieJar): Promise<{ studentId: string | null; name: string | null }> {
  const primed = await follow(`${APP_CONFIG_URL}?v=${Date.now()}`, { jar: cookies, maxHops: 4 });
  assertAlive(primed.url, primed.text);

  const res = await follow(STUDENT_INFO_URL, { jar: primed.jar, method: "POST", body: "", maxHops: 4 });
  assertAlive(res.url, res.text);

  let parsed;
  try {
    parsed = EgStudentResponse.parse(JSON.parse(res.text));
  } catch (cause) {
    throw new Error(`egate-app 学生信息接口返回异常：${(cause as Error).message}`);
  }
  if (String(parsed.code) !== "0") throw new Error(`egate-app 返回 code=${parsed.code}`);

  const row = parsed.datas?.hqdlxsjpcxx?.rows[0];
  return { studentId: row?.XSBH ?? null, name: row?.XM ?? null };
}
