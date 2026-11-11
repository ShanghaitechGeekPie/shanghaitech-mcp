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

/**
 * EAMS needs two priming hits: the first /eams/home.action returns a shell
 * (≈4.5KB), the second the real page (≈8KB) whose menu links the parsers rely
 * on. Verified live: without the second hit courseTableForStd.action has no
 * `bg.form.addInput(form,"ids",…)` and no default-semester literal.
 */
async function primeEams(auth: AuthContext): Promise<AuthContext> {
  let jar = auth.jar ?? {};
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await follow(`${EAMS_BASE}/eams/home.action`, authOptions(cookieAuth(jar), { maxHops: 4 }));
    assertAlive(res.url, res.text);
    jar = res.jar;
    if (/courseTableForStd\.action/.test(res.text)) break;
  }
  return cookieAuth(jar);
}

/**
 * EAMS returns a shell page (~4.5KB, no menu/ids) on some primed sessions and
 * the real one (~12KB) on others, non-deterministically. Retry the
 * home→courseTable pair until the page carries the parsers' markers.
 */
async function fetchEamsTable(auth: AuthContext): Promise<{ auth: AuthContext; text: string }> {
  let jar = auth.jar ?? {};
  for (let attempt = 0; attempt < 4; attempt++) {
    const home = await follow(`${EAMS_BASE}/eams/home.action`, authOptions(cookieAuth(jar), { maxHops: 4 }));
    assertAlive(home.url, home.text);
    const table = await follow(`${EAMS_BASE}/eams/courseTableForStd.action`, authOptions(cookieAuth(home.jar), { maxHops: 4 }));
    assertAlive(table.url, table.text);
    jar = table.jar;
    if (/semesterBar\d+/.test(table.text) && /bg\.form\.addInput/.test(table.text)) {
      return { auth: cookieAuth(jar), text: table.text };
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error("EAMS 课表页始终返回空壳（4 次重试），可能需要重新 ids_login");
}

/** Root CASTGC → EAMS session cookies, wrapped as an AuthContext. */
export async function deriveEamsSession(root: CookieJar): Promise<AuthContext> {
  const entry = await follow(
    `${EAMS_BASE}/eams/courseTableForStd.action`,
    authOptions(cookieAuth(root), { maxHops: 8, headers: { "user-agent": UA } }),
  );
  assertAlive(entry.url, entry.text);

  return primeEams(cookieAuth(entry.jar));
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
  const table = await fetchEamsTable(auth);

  // The semester dropdown is initialised by
  //   jQuery("#semesterBar<id>Semester").semesterCalendar({empty:"false",onChange:"",value:"282"},"searchTable()");
  // (the literal is locale-independent; only the markup labels are translated).
  const mysteryId = table.text.match(/semesterBar(\d+)Semester/)?.[1] ?? "";
  const defaultSemester = table.text.match(/semesterCalendar\(\{[^)]*?value:"(\d+)"/)?.[1] ?? null;

  const query = `tagId=semesterBar${mysteryId}Semester&dataType=semesterCalendar&value=6&empty=false`;
  const res = await follow(
    `${EAMS_BASE}/eams/dataQuery.action`,
    authOptions(table.auth, { method: "POST", body: query, maxHops: 2 }),
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
  const primed = await fetchEamsTable(auth);
  const detail = await follow(`${EAMS_BASE}/eams/stdDetail.action`, authOptions(primed.auth, { maxHops: 4 }));
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

// ---------------------------------------------------------------- exams
// Ported from shanghaitech-cpdaily-auth/lib/eams/eams.ts (getExamTable):
//   POST /eams/stdExamTable!innerIndex.action   (semesterId, examBatch.id, tutorRedirectstudentId)
//     → page with <select id="examBatchId"> of exam batches (期中/期末/…)
//   GET  /eams/stdExamTable!examTable.action?examBatch.id=<id>&tutorRedirectstudentId=<id>
//     → table.gridtable rows: 课程代码, 课程名称, 考试类型, 日期, 时间, 地点, 状态, 备注

function decodeEntities(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function gridRows(html: string): { headers: string[]; rows: string[][] } {
  const table = html.match(/<table[^>]*class="[^"]*gridtable[^"]*"[\s\S]*?<\/table>/i)?.[0] ?? "";
  const headerCells = [...(table.match(/<thead[\s\S]*?<\/thead>/i)?.[0] ?? "").matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(
    (m) => decodeEntities(m[1] ?? ""),
  );
  const body = table.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] ?? table;
  const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => [...(m[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => decodeEntities(c[1] ?? "")))
    .filter((cells) => cells.length >= 2);
  return { headers: headerCells, rows };
}

export interface EamsExamBatch {
  id: string;
  name: string;
  selected: boolean;
}

const EXAM_TYPE_ZH: Array<[RegExp, string]> = [
  [/interim|midterm|期中/i, "期中考试"],
  [/final|期末/i, "期末考试"],
  [/make-?up|补考/i, "补考"],
];

function localizeExamType(raw: string): string {
  for (const [re, zh] of EXAM_TYPE_ZH) if (re.test(raw)) return zh;
  return raw;
}

export interface EamsExam {
  courseCode: string;
  courseName: string;
  examType: string;
  examDate: string;
  examTimeRange: string;
  examPlace: string;
  examStatus: string;
  remark: string;
  seatUrl?: string;
}

async function primeAndStudentId(auth: AuthContext): Promise<{ auth: AuthContext; studentId: string }> {
  const table = await fetchEamsTable(auth);
  const studentId = table.text.match(/bg\.form\.addInput\(form,"ids","(\d+)"\)/)?.[1];
  if (!studentId) throw new Error(`EAMS 学号解析失败（${table.text.length} 字节）`);
  return { auth: table.auth, studentId };
}

export async function eamsExamBatches(
  auth: AuthContext,
  semesterId: string,
): Promise<{ auth: AuthContext; studentId: string; batches: EamsExamBatch[] }> {
  const { auth: primed, studentId } = await primeAndStudentId(auth);
  const body = `semesterId=${encodeURIComponent(semesterId)}&examBatch.id=&tutorRedirectstudentId=${encodeURIComponent(studentId)}`;
  const res = await follow(`${EAMS_BASE}/eams/stdExamTable!innerIndex.action`, authOptions(primed, { method: "POST", body, maxHops: 4 }));
  assertAlive(res.url, res.text);

  const select = res.text.match(/<select[^>]*id\s*=\s*"examBatchId"[^>]*>[\s\S]*?<\/select>/i)?.[0];
  if (!select) throw new Error(`EAMS 考试页缺 #examBatchId（${res.text.length} 字节）`);
  const batches = [...select.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)]
    .map((m) => ({
      id: (m[1] ?? "").trim(),
      name: decodeEntities(m[2] ?? ""),
      selected: /\bselected\b/i.test(m[0]),
    }))
    .filter((b) => b.id !== "");
  return { auth: cookieAuth(res.jar), studentId, batches };
}

export async function eamsExams(auth: AuthContext, semesterId: string, batchId?: string): Promise<{ batch: EamsExamBatch; exams: EamsExam[] }> {
  const { auth: primed, studentId, batches } = await eamsExamBatches(auth, semesterId);
  if (batches.length === 0) throw new Error("EAMS 该学期没有可选的考试批次");
  const batch = (batchId ? batches.find((b) => b.id === batchId) : batches.find((b) => b.selected)) ?? batches[0];
  if (!batch) throw new Error("EAMS 考试批次不存在");

  const url = `${EAMS_BASE}/eams/stdExamTable!examTable.action?examBatch.id=${encodeURIComponent(batch.id)}&tutorRedirectstudentId=${encodeURIComponent(studentId)}`;
  const res = await follow(url, authOptions(primed, { maxHops: 4 }));
  assertAlive(res.url, res.text);

  const { rows } = gridRows(res.text);
  const exams: EamsExam[] = rows
    .map((cells) => {
      const seatHref = cells[5];
      return {
        courseCode: cells[0] ?? "",
        courseName: cells[1] ?? "",
        examType: localizeExamType(cells[2] ?? ""),
        examDate: cells[3] ?? "",
        examTimeRange: cells[4] ?? "",
        examPlace: cells[5] ?? "",
        examStatus: cells[6] ?? "",
        remark: cells[7] ?? "",
        ...(seatHref && /examRoom/.test(seatHref) ? { seatUrl: seatHref } : {}),
      };
    })
    .filter((e) => e.courseCode || e.courseName);

  return { batch, exams };
}
