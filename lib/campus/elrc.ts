import { z } from "zod";
import { authOptions, cookieAuth, follow, type AuthContext, type CookieJar } from "./http";
import { CampusSessionExpired } from "./eams";

/**
 * ELRC (上海科技大学虚拟教学社区 / 在线课堂) adapter.
 *
 * Auth: ELRC is a CAS client of IDS.
 *   GET /unifiedlogin/v1/loginmanage/login/direction?redirect_url=<target>
 *     → 302 ids/authserver/login?service=<elrc>/unifiedlogin/v1/cas/login?redirect_url=…
 *     → 302 back with ticket → ELRC session cookies (S1_rman_sid / CsrfToken)
 *   GET /learn/login/info → 200 {status:200,data:{…}} when authenticated.
 *
 * Data (all verified live):
 *   GET  /learn/v1/course/video/review/-1?…           课程录播列表
 *   GET  /learn/v1/course/recording/video/info?…      课程详情 + 周次/视频
 *   POST /rman/v1/search/new/relation/videos          某次课的机位切片 (contentId_)
 *   GET  /learn/v1/homepage/course/keywordAndAbstract?videoId=…   AI 摘要 + 关键词
 *   GET  /rman/v1/intelligent/select/knowledge/summary?contentId=… AI 知识点分节
 *   POST /rman/v1/smart/voice/select                  语音转写全文（metadata: _in/_out）
 *   GET  /rman/v1/entity/file/screenshot?contentId=…   课件截图 + OCR 文本 + 时间点
 *
 * Time units: ELRC stores .NET ticks (100 ns). All exported times are seconds.
 */

export const ELRC_BASE = (process.env.ELRC_BASE_URL ?? "https://elrc.shanghaitech.edu.cn").replace(/\/+$/, "");

const TICKS_PER_SECOND = 1e7;

export class ElrcError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ElrcError";
  }
}

const loginInfo = z.object({ status: z.union([z.number(), z.string()]), data: z.unknown().nullable().optional() }).loose();

async function getJson<T>(auth: AuthContext, path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await follow(`${ELRC_BASE}${path}`, authOptions(auth, { maxHops: 3, timeoutMs: 20_000 }));
  if (res.status === 401 || res.status === 403) throw new CampusSessionExpired("ELRC 会话已失效，请重新 ids_login");
  let raw: unknown;
  try {
    raw = JSON.parse(res.text);
  } catch {
    throw new ElrcError(`ELRC 返回非 JSON（HTTP ${res.status}，${res.text.length} 字节）`, "bad_payload");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ElrcError(`ELRC 响应结构与预期不符：${parsed.error.message.slice(0, 160)}`, "parse_drift");
  return parsed.data;
}

async function postJson<T>(auth: AuthContext, path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const res = await follow(
    `${ELRC_BASE}${path}`,
    authOptions(auth, {
      method: "POST",
      body: JSON.stringify(body),
      maxHops: 2,
      timeoutMs: 20_000,
      headers: { "content-type": "application/json" },
    }),
  );
  if (res.status === 401 || res.status === 403) throw new CampusSessionExpired("ELRC 会话已失效，请重新 ids_login");
  let raw: unknown;
  try {
    raw = JSON.parse(res.text);
  } catch {
    throw new ElrcError(`ELRC 返回非 JSON（HTTP ${res.status}）`, "bad_payload");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ElrcError(`ELRC 响应结构与预期不符：${parsed.error.message.slice(0, 160)}`, "parse_drift");
  return parsed.data;
}

/** CASTGC → ELRC session cookies. */
export async function deriveElrcSession(root: CookieJar): Promise<AuthContext> {
  const target = encodeURIComponent(`${ELRC_BASE}/learn/`);
  const landed = await follow(`${ELRC_BASE}/unifiedlogin/v1/loginmanage/login/direction?redirect_url=${target}`, {
    ...authOptions(cookieAuth(root), { maxHops: 12, timeoutMs: 20_000 }),
  });
  if (landed.url.includes("ids.shanghaitech.edu.cn") || landed.text.includes("统一身份认证")) {
    throw new CampusSessionExpired("ELRC 被重定向回 IDS 登录页，CASTGC 已失效，请重新 ids_login");
  }
  const jar: CookieJar = { ...landed.jar };
  if (!Object.keys(jar).some((k) => /rman_sid|JSESSIONID|SESSION/i.test(k))) {
    throw new CampusSessionExpired("ELRC 登录后没有会话 cookie");
  }
  const info = await follow(`${ELRC_BASE}/learn/login/info`, { ...authOptions(cookieAuth(jar), { maxHops: 2 }) });
  const parsed = loginInfo.safeParse(JSON.parse(info.text));
  if (!parsed.success || String(parsed.data.status) !== "200") {
    throw new CampusSessionExpired("ELRC 登录态校验失败，请重新 ids_login");
  }
  return cookieAuth(jar);
}

// ---------------------------------------------------------------- courses

const CourseRow = z
  .object({
    id: z.number(),
    courseId: z.string(),
    courseName: z.string(),
    courseNumber: z.string().nullable().optional(),
    serialNumber: z.string().nullable().optional(),
    teachers: z.string().nullable().optional(),
    courseTime: z.string().nullable().optional(),
    academicBuilding: z.string().nullable().optional(),
    classroomNumber: z.string().nullable().optional(),
    schoolYear: z.string().nullable().optional(),
    semester: z.string().nullable().optional(),
  })
  .loose();
export type ElrcCourse = z.infer<typeof CourseRow>;

const CoursePage = z.object({ data: z.object({ results: z.array(CourseRow).nullable().optional(), total: z.number().nullable().optional() }).loose() }).loose();

export interface CourseQuery {
  keyword?: string;
  year?: string;
  semester?: string;
  page?: number;
  size?: number;
}

export async function listCourses(auth: AuthContext, q: CourseQuery = {}): Promise<ElrcCourse[]> {
  const sem = q.semester ?? "秋季";
  const year = q.year ?? "2026-2027";
  const query = new URLSearchParams({
    type: "-1",
    courseName: q.keyword ?? "",
    teacherName: "",
    campus: "",
    academicBuilding: "",
    classroom: "",
    order: "",
    schoolYear: year,
    semester: sem,
    playType: "0",
    courseTime: "1",
    page: String(q.page ?? 1),
    size: String(q.size ?? 20),
  });
  const page = await getJson(auth, `/learn/v1/course/video/review/-1?${query}`, CoursePage);
  return page.data.results ?? [];
}

const VideoRef = z
  .object({
    videoId: z.string(),
    videoName: z.string(),
    scheduleId: z.string().nullable().optional(),
    startTime: z.string().nullable().optional(),
    endTime: z.string().nullable().optional(),
  })
  .loose();

const SessionRef = z
  .object({
    weekDay: z.string(),
    weekDate: z.string().nullable().optional(),
    realSection: z.string().nullable().optional(),
    videoInfoList: z.array(VideoRef).nullable().optional(),
  })
  .loose();

const WeekRef = z
  .object({
    week: z.string(),
    startTime: z.string().nullable().optional(),
    endTime: z.string().nullable().optional(),
    recordInfoDetailList: z.array(SessionRef).nullable().optional(),
  })
  .loose();

const CourseInfo = z
  .object({
    courseId: z.string(),
    courseName: z.string(),
    schoolYear: z.string().nullable().optional(),
    semester: z.string().nullable().optional(),
    teacherList: z.array(z.object({ userName: z.string() }).loose()).nullable().optional(),
    collegeList: z.array(z.object({ value: z.string() }).loose()).nullable().optional(),
    coursePositionList: z
      .array(z.object({ academicBuilding: z.string().nullable().optional(), classroomNumber: z.string().nullable().optional() }).loose())
      .nullable().optional(),
    recordingVideoInfoShows: z.array(WeekRef).nullable().optional(),
  })
  .loose();
export type ElrcCourseInfo = z.infer<typeof CourseInfo>;

export async function courseInfo(auth: AuthContext, courseId: string, id: number, year?: string, semester?: string): Promise<ElrcCourseInfo> {
  const query = new URLSearchParams({
    courseId,
    id: String(id),
    schoolYear: year ?? "2026-2027",
    semester: semester ?? "秋季",
  });
  const parsed = await getJson(auth, `/learn/v1/course/recording/video/info?${query}`, z.object({ data: CourseInfo }).loose());
  return parsed.data;
}

const ClipRow = z
  .object({
    contentId_: z.string(),
    seat: z.string().nullable().optional(),
    name_: z.string().nullable().optional(),
    duration: z.number().nullable().optional(),
    asr_status: z.string().nullable().optional(),
    smart_status: z.string().nullable().optional(),
    describe: z.string().nullable().optional(),
  })
  .loose();
export type ElrcClip = z.infer<typeof ClipRow>;

const ClipPage = z.object({ data: z.object({ data: z.array(ClipRow).nullable().optional() }).loose() }).loose();

export interface ClipQuery {
  courseNumber: string;
  serialNumber: string;
  week: string;
  weekDay: string;
  section: string;
  scheduleIds: string[];
}

export async function listClips(auth: AuthContext, q: ClipQuery): Promise<ElrcClip[]> {
  const page = await postJson(
    auth,
    "/rman/v1/search/new/relation/videos",
    {
      courseId: q.courseNumber,
      courseNo: q.serialNumber,
      week: q.week,
      weekDay: q.weekDay,
      section: q.section,
      scheduleIds: q.scheduleIds,
      isGetCut: true,
    },
    ClipPage,
  );
  return page.data.data ?? [];
}

// ---------------------------------------------------------------- per-recording

const KeywordAbstract = z
  .object({
    keyword: z.array(z.string()).nullable().optional(),
    description: z.string().nullable().optional(),
  })
  .loose()
  .nullable();

export interface RecordingSummary {
  abstract: string | null;
  keywords: string[];
  sections: Array<{ title: string; startSec: number; endSec: number }>;
  slides: Array<{ startSec: number; text: string; image: string; type: string | null }>;
}

const Knowledge = z
  .object({
    data: z
      .array(
        z
          .object({
            knowledgePoints: z
              .array(z.object({ title: z.string(), inPoint: z.number(), outPoint: z.number() }).loose())
              .nullable()
              .optional(),
          })
          .loose(),
      )
      .nullable()
      .optional(),
  })
  .loose();

const Slides = z
  .object({
    data: z
      .object({
        recordTotal: z.number().nullable().optional(),
        data: z
          .array(
            z
              .object({
                description: z.string().nullable().optional(),
                filePath: z.string().nullable().optional(),
                nextInPoint: z.number().nullable().optional(),
                type: z.string().nullable().optional(),
              })
              .loose(),
          )
          .nullable()
          .optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();

export async function recordingSummary(auth: AuthContext, contentId: string): Promise<RecordingSummary> {
  const [ka, ks, ss] = await Promise.all([
    getJson(auth, `/learn/v1/homepage/course/keywordAndAbstract?videoId=${encodeURIComponent(contentId)}`, z.object({ data: KeywordAbstract }).loose()),
    getJson(auth, `/rman/v1/intelligent/select/knowledge/summary?contentId=${encodeURIComponent(contentId)}`, Knowledge),
    getJson(auth, `/rman/v1/entity/file/screenshot?page=1&size=100&contentId=${encodeURIComponent(contentId)}`, Slides),
  ]);

  const sections =
    (ks.data ?? []).flatMap((group) =>
      (group.knowledgePoints ?? []).map((p) => ({
        title: p.title,
        startSec: Math.round(p.inPoint / TICKS_PER_SECOND),
        endSec: Math.round(p.outPoint / TICKS_PER_SECOND),
      })),
    ) ?? [];

  const slides = (ss.data?.data ?? []).map((s) => ({
    startSec: Math.round((s.nextInPoint ?? 0) / TICKS_PER_SECOND),
    text: s.description ?? "",
    image: s.filePath ?? "",
    type: s.type ?? null,
  }));

  return {
    abstract: ka.data?.description ?? null,
    keywords: ka.data?.keyword ?? [],
    sections,
    slides,
  };
}

const Voice = z
  .object({
    data: z
      .object({
        data: z
          .array(
            z
              .object({
                metadata: z
                  .array(
                    z
                      .object({ _in: z.number(), _out: z.number(), text: z.string(), text_en: z.string().nullable().optional() })
                      .loose(),
                  )
                  .nullable()
                  .optional(),
              })
              .loose(),
          )
          .nullable()
          .optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  textEn: string | null;
}

export async function transcript(auth: AuthContext, contentId: string): Promise<TranscriptSegment[]> {
  const raw = await postJson(
    auth,
    "/rman/v1/smart/voice/select",
    { contentid: contentId, metadataType: "model_sobey_smart_voice_" },
    Voice,
  );
  const segments = (raw.data?.data ?? []).flatMap((item) => item.metadata ?? []);
  return segments
    .map((s) => ({
      start: Math.round(s._in / TICKS_PER_SECOND),
      end: Math.round(s._out / TICKS_PER_SECOND),
      text: s.text,
      textEn: s.text_en ?? null,
    }))
    .sort((a, b) => a.start - b.start);
}

export function elrcFileUrl(path: string): string {
  return `${ELRC_BASE}${path}`;
}
