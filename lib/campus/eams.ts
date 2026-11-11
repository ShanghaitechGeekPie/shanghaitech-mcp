import { authOptions, cookieAuth, follow, type AuthContext, type CookieJar } from "./http";

/**
 * EAMS (教务系统) adapter.
 *
 * Ported from the reference implementation in `shanghaitech-cpdaily-auth`
 * (`lib/eams/eams.ts`, `lib/thirdparty/eams.ts`), which is the same chain the
 * TechPie backend exposes as `POST /auth/third-party/eams {tgc}`.
 *
 * Chain:
 *   1. GET /eams/courseTableForStd.action with `Cookie: CASTGC=<tgc>`
 *      → 302 ids…/authserver/login?service=<EAMS-generated>   (register EAMS)
 *      → 302 back to EAMS?ticket=ST-…                          (consume ticket)
 *      → 200, `Set-Cookie: JSESSIONID=…`
 *   2. GET /eams/home.action with the new JSESSIONID — mandatory priming;
 *      without it courseTableForStd.action returns a shell page with none of
 *      the JS the parsers depend on.
 *
 * EAMS generates its own `service=` in the 302, so no literal is registered
 * here — follow the redirect and let the jar collect cookies.
 */

export const EAMS_BASE = (process.env.EAMS_BASE_URL ?? "https://eams.shanghaitech.edu.cn").replace(/\/+$/, "");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/126.0.0.0 Safari/537.36";

export class CampusSessionExpired extends Error {
  constructor(message = "校园登录态已失效") {
    super(message);
    this.name = "CampusSessionExpired";
  }
}

/** IDS bounces unauthenticated requests to its own login page. */
function assertAlive(url: string, text: string): void {
  if (url.includes("ids.shanghaitech.edu.cn") || text.includes("统一身份认证平台") || text.includes("统一身份认证")) {
    throw new CampusSessionExpired("CASTGC 已失效，请重新 ids_login");
  }
}

/** Root CASTGC → EAMS session cookies, wrapped as an AuthContext. */
export async function deriveEamsSession(root: CookieJar): Promise<AuthContext> {
  const entry = await follow(
    `${EAMS_BASE}/eams/courseTableForStd.action`,
    authOptions(cookieAuth(root), { maxHops: 8, headers: { "user-agent": UA } }),
  );
  assertAlive(entry.url, entry.text);

  const primed = await follow(`${EAMS_BASE}/eams/home.action`, authOptions(cookieAuth(entry.jar), { maxHops: 4 }));
  assertAlive(primed.url, primed.text);
  return cookieAuth(primed.jar);
}

export interface EamsSemester {
  id: string;
  year: string;
  name: string;
}

export interface EamsSemesters {
  defaultSemester: string | null;
  semesters: EamsSemester[];
}

export async function eamsSemesters(auth: AuthContext): Promise<EamsSemesters> {
  const table = await follow(`${EAMS_BASE}/eams/courseTableForStd.action`, authOptions(auth, { maxHops: 4 }));
  assertAlive(table.url, table.text);

  // EAMS embeds a per-session "mystery id" that keys the semester dropdown.
  const mysteryId = table.text.split('"></div>')[0]?.slice(-11) ?? "";
  const defaultSemester = table.text.match(/\{empty:"false",value:"(\d+)"},"searchTable\(\)"\);/)?.[1] ?? null;

  const query = `tagId=semesterBar${mysteryId}Semester&dataType=semesterCalendar&value=6&empty=false`;
  const res = await follow(
    `${EAMS_BASE}/eams/dataQuery.action`,
    authOptions(cookieAuth(table.jar), { method: "POST", body: query, maxHops: 2 }),
  );
  assertAlive(res.url, res.text);

  const semesters: EamsSemester[] = [];
  for (const m of res.text.matchAll(/\{id:(\d+),schoolYear:"(\d+-\d+)",name:"(.*?)"}/g)) {
    const [, id, year, name] = m;
    if (id && year && name) semesters.push({ id, year, name: name.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim() });
  }
  if (semesters.length === 0) {
    throw new Error("EAMS 学期列表解析失败：页面结构可能已变化");
  }
  return { defaultSemester, semesters };
}

export interface EamsProfile {
  studentId: string | null;
  name: string | null;
}

export async function eamsProfile(auth: AuthContext): Promise<EamsProfile> {
  const detail = await follow(`${EAMS_BASE}/eams/stdDetail.action`, authOptions(auth, { maxHops: 4 }));
  assertAlive(detail.url, detail.text);

  // Labels are localised ("姓名：" / "Name："), values live in the next <td>.
  const studentId = detail.text.match(/Student No[：:]\s*<\/td>\s*<td[^>]*>(\d+)</)?.[1] ?? null;
  const name =
    detail.text.match(/(?:^|>)(?:Name|姓名)[：:]\s*<\/td>\s*<td[^>]*>([^<]{1,40})</)?.[1] ??
    detail.text.match(/id='photoImg'[\s\S]{0,200}?alt="([^"]{1,40})"/)?.[1] ??
    null;

  if (!studentId && !name) {
    // Silent nulls hide markup/locale drift; make the failure diagnosable.
    const title = detail.text.match(/<title>([^<]*)<\/title>/)?.[1]?.trim() || "untitled";
    throw new Error(`EAMS 学籍页解析失败（title "${title}", ${detail.text.length} 字节）`);
  }

  return {
    studentId,
    name: name ? name.replace(/\u00a0/g, " ").trim() : null,
  };
}
