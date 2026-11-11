import { authOptions, cookieAuth, follow, type AuthContext, type CookieJar } from "./http";
import { decodeEntities, textOf } from "./html";
import { CampusSessionExpired } from "./eams";

/**
 * Blackboard Learn (elearning.shanghaitech.edu.cn:8443) adapter.
 *
 * Login chain (ported from shanghaitech-cpdaily-auth/lib/deadlines/blackboard.ts,
 * verified against the live site):
 *   GET  IDS /authserver/login?service=<bb index.jsp>  (Cookie: CASTGC=…)
 *     → … → elearning SSO form HTML (a page full of <input name=… value=…>)
 *   POST {base}/webapps/bb-sso-BBLEARN/execute/authValidate/customLogin  (those inputs)
 *     → session cookies
 *   GET  {base}/webapps/bb-BB-BBLEARN/index.jsp  → dashboard, confirms the session
 *
 * Blackboard frequently needs 15–20s for this chain and the first attempt can
 * stall, so it is retried once on timeout.
 */

export const BB_BASE = (process.env.ELEARNING_BASE_URL ?? "https://elearning.shanghaitech.edu.cn:8443").replace(/\/+$/, "");

const BB_UA = "Mozilla/5.0";

function ssoServiceUrl(): string {
  return `${IDS_BASE()}/authserver/login?service=${encodeURIComponent(`${BB_BASE}/webapps/bb-BB-BBLEARN/index.jsp`)}`;
}

function IDS_BASE(): string {
  return (process.env.IDS_BASE_URL ?? "https://ids.shanghaitech.edu.cn").replace(/\/+$/, "");
}

function formInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/gi)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

export async function deriveBlackboardSession(root: CookieJar): Promise<AuthContext> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const login = await follow(ssoServiceUrl(), authOptions(cookieAuth(root), { maxHops: 12, timeoutMs: 20_000, headers: { "user-agent": BB_UA } }));
      if (login.url.includes("ids.shanghaitech.edu.cn") || login.text.includes("统一身份认证")) {
        throw new CampusSessionExpired("elearning SSO 停留在 IDS 登录页，CASTGC 已失效，请重新 ids_login");
      }

      const inputs = formInputs(login.text);
      if (Object.keys(inputs).length === 0) {
        throw new Error(`elearning SSO 页面没有表单（${login.text.length} 字节，停在 ${new URL(login.url).pathname}）`);
      }

      const posted = await follow(`${BB_BASE}/webapps/bb-sso-BBLEARN/execute/authValidate/customLogin`, {
        method: "POST",
        body: new URLSearchParams(inputs).toString(),
        jar: login.jar,
        maxHops: 6,
        timeoutMs: 20_000,
        headers: { "user-agent": BB_UA },
      });

      const index = await follow(`${BB_BASE}/webapps/bb-BB-BBLEARN/index.jsp`, {
        jar: posted.jar,
        maxHops: 4,
        timeoutMs: 20_000,
        headers: { "user-agent": BB_UA },
      });

      const jar: CookieJar = { ...index.jar };
      if (!jar.session_id && !jar.s_session_id && jar.JSESSIONID) jar.session_id = jar.JSESSIONID;
      if (!jar.session_id && !jar.s_session_id) {
        throw new Error("elearning 登录后没有会话 cookie（session_id / s_session_id / JSESSIONID）");
      }
      if (/<title>\s*Sign In\s*<\/title>/i.test(index.text)) {
        throw new CampusSessionExpired("elearning 仍停留在登录页，请重新 ids_login");
      }
      return cookieAuth(jar);
    } catch (e) {
      lastError = e;
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) continue;
      throw e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("elearning SSO 多次超时");
}


// ---------------------------------------------------------------- data

export class ElearningError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ElearningError";
  }
}

const BB_UA_HEADERS = { "user-agent": BB_UA };

function bbGet(auth: AuthContext, path: string, maxHops = 4) {
  return follow(`${BB_BASE}${path}`, authOptions(auth, { maxHops, headers: BB_UA_HEADERS }));
}

/** Dashboard tab that lists the student's courses. */
export async function bbCourses(auth: AuthContext): Promise<Array<{ id: string; name: string; code: string | null }>> {
  const page = await bbGet(auth, "/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1");
  const out = new Map<string, { id: string; name: string; code: string | null }>();
  for (const m of page.text.matchAll(/<a[^>]*href="([^"]*launcher\?type=Course&id=(_[0-9]+_1)[^"]*)"[^>]*>([\s\S]{0,900}?)<\/a>/g)) {
    const id = m[2]!;
    if (out.has(id)) continue;
    const raw = textOf(m[3]!);
    if (!raw) continue;
    // The outer anchor wraps the course name and an inner schedule anchor
    // ("(...) 物质学院 1-401 第1-16周 …"); cut at the first bracket.
    const name = raw.split(/[（(]/)[0]?.replace(/\s*\.\.\.+$/, "").trim() || raw;
    const code = raw.match(/\b([A-Z]{2,}[0-9][A-Z0-9.]*)\b/)?.[1] ?? null;
    const previous = out.get(id);
    if (!previous || (previous.name.startsWith("(") && !name.startsWith("("))) out.set(id, { id, name, code });
  }
  if (out.size === 0) {
    throw new ElearningError(`elearning 课程列表解析失败（${page.text.length} 字节）`, "parse_drift");
  }
  return [...out.values()];
}

export interface BbAnnouncement {
  id: string;
  title: string;
  published: string | null;
  body: string;
}

function parseAnnouncements(html: string): BbAnnouncement[] {
  const list = html.match(/<ul[^>]*id="announcementList"[\s\S]*?<\/ul>/i)?.[0];
  if (!list) return [];
  const out: BbAnnouncement[] = [];
  for (const chunk of list.split(/<li[\s>]/i).slice(1)) {
    const id = chunk.match(/id="(_[0-9]+_1)"/i)?.[1] ?? "";
    const title = chunk.match(/<h3[^>]*class="item"[^>]*>([\s\S]*?)<\/h3>/i)?.[1];
    const published = chunk.match(/发布时间[:：]\s*([^<]+)</i)?.[1];
    const bodyHtml = chunk.match(/<div[^>]*class="vtbegenerated"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "";
    if (!title) continue;
    out.push({
      id,
      title: textOf(title),
      published: published ? decodeEntities(published).replace(/\s+/g, " ").trim() : null,
      body: textOf(bodyHtml),
    });
  }
  return out;
}

/** Announcements for one course, or the institution-wide list when courseId is omitted. */
export async function bbAnnouncements(auth: AuthContext, courseId?: string, limit = 20): Promise<BbAnnouncement[]> {
  const path = courseId
    ? `/webapps/blackboard/execute/announcement?method=search&context=course&course_id=${encodeURIComponent(courseId)}`
    : "/webapps/blackboard/execute/announcement?method=search&context=myorganization";
  const page = await bbGet(auth, path);
  const items = parseAnnouncements(page.text);
  if (items.length === 0 && /签到|Sign In|login/i.test(page.text.slice(0, 500))) {
    throw new CampusSessionExpired("elearning 会话已失效，请重新 ids_login");
  }
  return items.slice(0, limit);
}

export interface BbAssignment {
  id: string;
  title: string;
  course: string;
  due: string | null;
  attemptable: boolean;
  url: string | null;
}

/** Deadlines come from Blackboard's calendar API (all courses, graded items only). */
export async function bbAssignments(auth: AuthContext, limit = 50): Promise<BbAssignment[]> {
  const res = await bbGet(auth, `/webapps/calendar/calendarData/allCourseEvents?start=${Date.now()}`, 2);
  if (!res.text.trimStart().startsWith("[")) {
    throw new ElearningError(`elearning 日历接口返回非 JSON（HTTP ${res.status}）`, "bad_payload");
  }
  const raw = JSON.parse(res.text) as Array<Record<string, unknown>>;
  return raw
    .filter((item) => item.gradable === true || item.itemSourceType === "blackboard.platform.gradebook2.GradableItem")
    .map((item) => {
      const sourceId = item.itemSourceId ? String(item.itemSourceId) : "";
      return {
        id: sourceId || String(item.id ?? ""),
        title: String(item.title ?? ""),
        course: String(item.calendarName ?? "").trim(),
        due: item.end ? String(item.end) : null,
        attemptable: item.attemptable === true,
        url: sourceId
          ? `${BB_BASE}/webapps/calendar/launch/attempt/_blackboard.platform.gradebook2.GradableItem-${sourceId}`
          : null,
      };
    })
    .slice(0, limit);
}

export interface BbContentItem {
  kind: "folder" | "file";
  name: string;
  /** Folder: its content_id. File: the /bbcswebdav/… path. */
  ref: string;
}

/** One level of a course content folder (files + subfolders). */
export async function bbContents(auth: AuthContext, courseId: string, contentId?: string): Promise<BbContentItem[]> {
  const path = contentId
    ? `/webapps/blackboard/content/listContent.jsp?course_id=${encodeURIComponent(courseId)}&content_id=${encodeURIComponent(contentId)}&mode=reset`
    : `/webapps/blackboard/content/listContent.jsp?course_id=${encodeURIComponent(courseId)}&mode=reset`;
  const page = await bbGet(auth, path);
  const items = new Map<string, BbContentItem>();

  for (const m of page.text.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]{0,240}?)<\/a>/g)) {
    const href = decodeEntities(m[1]!);
    const name = textOf(m[2]!);
    if (!name) continue;
    const file = href.match(/^\/bbcswebdav\/[^"]+$/);
    if (file) {
      items.set(`file:${href}`, { kind: "file", name, ref: href });
      continue;
    }
    const folder = href.match(/listContent\.jsp\?[^"]*content_id=(_[0-9]+_1)/);
    if (folder && folder[1] !== contentId) {
      items.set(`folder:${folder[1]}`, { kind: "folder", name, ref: folder[1]! });
    }
  }
  if (items.size === 0 && !new RegExp(courseId).test(page.text)) {
    throw new ElearningError(`elearning 课程内容页异常（${page.text.length} 字节）`, "parse_drift");
  }
  return [...items.values()];
}

export interface BbFile {
  name: string;
  mimeType: string;
  size: number;
  base64: string;
}

/** Fetch a /bbcswebdav/… file with the session. Callers cap the size. */
export async function bbFile(auth: AuthContext, path: string, maxBytes = 1_500_000): Promise<BbFile | { tooLarge: true; size: number }> {
  if (!path.startsWith("/bbcswebdav/")) throw new ElearningError("只接受 /bbcswebdav/ 开头的课件路径", "bad_path");
  const res = await fetch(`${BB_BASE}${path}`, {
    headers: { ...BB_UA_HEADERS, cookie: Object.entries(auth.jar ?? {}).map(([k, v]) => `${k}=${v}`).join("; ") },
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new ElearningError(`课件下载失败（HTTP ${res.status}）`, String(res.status));
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > maxBytes) {
    await res.body?.cancel();
    return { tooLarge: true, size: len };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) return { tooLarge: true, size: buf.length };
  const name = decodeURIComponent(path.split("/").pop() ?? "file");
  return {
    name,
    mimeType: res.headers.get("content-type") ?? "application/octet-stream",
    size: buf.length,
    base64: buf.toString("base64"),
  };
}
