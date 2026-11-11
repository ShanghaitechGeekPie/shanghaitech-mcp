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


// ---------------------------------------------------------------- unified platform

const CurrentSemester = z
  .object({
    data: z
      .object({
        currentSemester: z
          .object({ name: z.string(), showSemester: z.string().nullable().optional(), semester: z.string().nullable().optional() })
          .loose()
          .nullable()
          .optional(),
      })
      .loose(),
  })
  .loose();

export interface Semester {
  /** "2026-2027学年秋季" — the value the course list expects. */
  name: string;
  /** "2026-2027" */
  year: string;
  /** "1" | "2" | "3" */
  term: string;
}

export function parseSemesterName(name: string): Semester {
  const m = name.match(/(\d{4}-\d{4})学年(秋季|春季|夏季)/);
  const term = m?.[2] === "春季" ? "2" : m?.[2] === "夏季" ? "3" : "1";
  return { name, year: m?.[1] ?? "2026-2027", term };
}

export async function currentSemester(auth: AuthContext): Promise<Semester> {
  const res = await getJson(auth, "/learn/v1/dropdownbox/semester/manage/current", CurrentSemester);
  const name = res.data.currentSemester?.name;
  if (!name) throw new ElrcError("ELRC 未返回当前学期", "parse_drift");
  return parseSemesterName(name);
}

const MyCourseRow = z
  .object({
    entityData: z
      .object({
        contentId_: z.string(),
        name_: z.string(),
        name: z.string().nullable().optional(),
        classTeaching: z.string().nullable().optional(),
        courseNumber: z.string().nullable().optional(),
        teacher_names: z.array(z.string()).nullable().optional(),
        classTime: z.string().nullable().optional(),
        collegeName: z.array(z.string()).nullable().optional(),
        course_semester_id: z.union([z.string(), z.number()]).nullable().optional(),
        semester_teaching_courses: z.string().nullable().optional(),
      })
      .loose(),
  })
  .loose();

const MyCourses = z
  .object({
    data: z
      .object({ total: z.number().nullable().optional(), results: z.array(MyCourseRow).nullable().optional() })
      .loose(),
  })
  .loose();

export interface MyCourse {
  courseId: string;
  name: string;
  serialNumber: string | null;
  courseNumber: string | null;
  teachers: string[];
  classTime: string | null;
  colleges: string[];
  courseSemesterId: string | null;
  semester: string | null;
}

export async function myCourses(auth: AuthContext, semesterName: string): Promise<MyCourse[]> {
  const query = new URLSearchParams({
    pageIndex: "1",
    pageSize: "48",
    courseType: "2",
    semester: semesterName,
  });
  const res = await getJson(auth, `/learn/v1/learningsituation/teaching/course/get/participated/courses/list?${query}`, MyCourses);
  return (res.data.results ?? []).map((row) => {
    const e = row.entityData;
    return {
      courseId: e.contentId_,
      name: e.name_ || e.name || "",
      serialNumber: e.classTeaching ?? null,
      courseNumber: e.courseNumber ?? null,
      teachers: e.teacher_names ?? [],
      classTime: e.classTime ?? null,
      colleges: e.collegeName ?? [],
      courseSemesterId: e.course_semester_id != null ? String(e.course_semester_id) : null,
      semester: e.semester_teaching_courses ?? null,
    };
  });
}

export interface ElrcSyllabus {
  description: string | null;
  objectives: string | null;
  methods: string | null;
  schedule: string | null;
  assessment: string | null;
  integrity: string | null;
  other: string | null;
}

export interface ElrcCourseDetail {
  name: string;
  enName: string | null;
  credits: string | null;
  classHour: string | null;
  syllabus: ElrcSyllabus | null;
  /** 关联第三方平台：名称 + 链接。 */
  platforms: Array<{ platform: string; courseName?: string; teacher?: string; status?: string; url?: string }>;
  timetable: Array<{ dayOfWeek: number | null; weeks: string | null; slots: string | null; place: string | null; teacher: string | null }>;
  chapters: Array<{ name: string; children: string[] }>;
}

const DataSync = z.object({ extend_message: z.record(z.string(), z.unknown()) }).loose();

export async function courseDetail(
  auth: AuthContext,
  course: MyCourse,
  semester: Semester,
): Promise<ElrcCourseDetail> {
  if (!course.serialNumber || !course.courseNumber) {
    throw new ElrcError("课程缺少课程号，无法查询教务详情", "no_course_no");
  }
  const base = `/shanghaitechdatasync/datasync/bksCourse/?semester=${encodeURIComponent(semester.year)}&term=${encodeURIComponent(semester.term)}&course_no=${encodeURIComponent(course.serialNumber)}&course_id=${encodeURIComponent(course.courseNumber)}`;
  const raw = await getJson(auth, base, DataSync);
  const em = raw.extend_message;
  const basic = z
    .object({ course_name: z.string().optional(), course_en_name: z.string().nullable().optional(), credits: z.string().nullable().optional(), class_hour: z.string().nullable().optional() })
    .loose()
    .safeParse(em["JwPkKcxxBk_instance"] ?? {});
  const syl = z
    .object({
      course_description: z.string().nullable().optional(),
      teaching_methods: z.string().nullable().optional(),
      teaching_objectives: z.string().nullable().optional(),
      course_content_schedule: z.string().nullable().optional(),
      assessment_criteria: z.string().nullable().optional(),
      academic_integrity: z.string().nullable().optional(),
      other_information: z.string().nullable().optional(),
    })
    .loose()
    .safeParse(em["jxdg_instance"] ?? {});

  const docking = z.object({ platform: z.string().nullable().optional() }).loose().safeParse(em["CourseDocking_instance"] ?? {});
  const eyun = z
    .object({
      course: z
        .array(
          z
            .object({
              course_name: z.string().nullable().optional(),
              course_tea: z.string().nullable().optional(),
              status: z.string().nullable().optional(),
              course_url: z.string().nullable().optional(),
            })
            .loose(),
        )
        .nullable()
        .optional(),
    })
    .loose()
    .safeParse(em["eyun_course"] ?? {});

  const platforms: ElrcCourseDetail["platforms"] = [];
  if (docking.success && docking.data.platform) platforms.push({ platform: docking.data.platform });

  const eyunCourses = (eyun.success ? eyun.data.course ?? [] : []).map((c) => ({
    platform: "eCourse",
    courseName: c.course_name ?? undefined,
    teacher: c.course_tea?.replace(/,$/, "") ?? undefined,
    status: c.status ?? undefined,
    url: c.course_url ?? undefined,
  }));
  // eCourse returns every parallel class of the course; keep the student's own
  // serial number when it matches, otherwise a few representatives.
  const own = course.serialNumber
    ? eyunCourses.filter((c) => c.courseName?.includes(course.serialNumber!))
    : [];
  platforms.push(...(own.length > 0 ? own : eyunCourses.slice(0, 3)));

  return {
    name: basic.success ? basic.data.course_name ?? course.name : course.name,
    enName: basic.success ? basic.data.course_en_name ?? null : null,
    credits: basic.success ? basic.data.credits ?? null : null,
    classHour: basic.success ? basic.data.class_hour ?? null : null,
    syllabus: syl.success
      ? {
          description: syl.data.course_description ?? null,
          objectives: syl.data.teaching_objectives ?? null,
          methods: syl.data.teaching_methods ?? null,
          schedule: syl.data.course_content_schedule ?? null,
          assessment: syl.data.assessment_criteria ?? null,
          integrity: syl.data.academic_integrity ?? null,
          other: syl.data.other_information ?? null,
        }
      : null,
    platforms,
    timetable: await timetable(auth, course, semester),
    chapters: await chapters(auth, course),
  };
}

const TimeTable = z
  .object({
    extend_message: z
      .array(
        z
          .object({
            day_of_week: z.number().nullable().optional(),
            times: z.string().nullable().optional(),
            slot_start: z.string().nullable().optional(),
            slot_stop: z.string().nullable().optional(),
            area_name: z.string().nullable().optional(),
            teacher_name: z.string().nullable().optional(),
          })
          .loose(),
      )
      .nullable()
      .optional(),
  })
  .loose();

async function timetable(auth: AuthContext, course: MyCourse, semester: Semester): Promise<ElrcCourseDetail["timetable"]> {
  if (!course.serialNumber) return [];
  const path = `/shanghaitechdatasync/datasync/bksCourseTimeTable/?semester=${encodeURIComponent(semester.year)}&term=${encodeURIComponent(semester.term)}&course_no=${encodeURIComponent(course.serialNumber)}&times=1`;
  const res = await getJson(auth, path, TimeTable);
  return (res.extend_message ?? []).map((t) => ({
    dayOfWeek: t.day_of_week ?? null,
    weeks: t.times ?? null,
    slots: t.slot_start && t.slot_stop ? `${t.slot_start}-${t.slot_stop}` : null,
    place: t.area_name ?? null,
    teacher: t.teacher_name ?? null,
  }));
}

const Chapters = z
  .object({
    data: z
      .array(
        z
          .object({
            info: z.object({ chapter_name: z.string() }).loose(),
            childInfo: z
              .array(z.object({ info: z.object({ chapter_name: z.string() }).loose() }).loose())
              .nullable()
              .optional(),
          })
          .loose(),
      )
      .nullable()
      .optional(),
  })
  .loose();

async function chapters(auth: AuthContext, course: MyCourse): Promise<ElrcCourseDetail["chapters"]> {
  const semester = course.courseSemesterId ?? "1";
  const res = await getJson(
    auth,
    `/learn/v1/homepage/chapter/info?courseId=${encodeURIComponent(course.courseId)}&type=false&semester=${encodeURIComponent(semester)}`,
    Chapters,
  );
  return (res.data ?? []).map((c) => ({
    name: c.info.chapter_name,
    children: (c.childInfo ?? []).map((x) => x.info.chapter_name),
  }));
}


// ---------------------------------------------------------------- course search (all semesters)

/**
 * Course-center search. Backed by the dedicated API (no HTML scraping):
 *   GET /learn/shanghai/tech/get/course?keyword=&page=&size=&sort=semester
 * Covers every semester (~11k courses). Each row carries contentId_,
 * serialNumber, courseNumber, teacher_names and semester_show_name.
 */
const SearchRow = z
  .object({
    contentId_: z.string(),
    name_: z.string(),
    serialNumber: z.string().nullable().optional(),
    courseNumber: z.string().nullable().optional(),
    teacher_names: z.array(z.string()).nullable().optional(),
    semester_show_name: z.string().nullable().optional(),
    course_semester_id: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .loose();

const CourseSearch = z
  .object({
    data: z
      .object({
        page: z.number(),
        size: z.number(),
        total: z.number(),
        results: z.array(SearchRow).nullable().optional(),
      })
      .loose(),
  })
  .loose();

export interface CourseSearchResult {
  total: number;
  page: number;
  size: number;
  courses: MyCourse[];
}

/** "2026-2027-1" → "2026-2027学年秋季" (the form the course list expects). */
export function semesterFromShow(show: string | null | undefined): string | null {
  if (!show) return null;
  const m = show.match(/(\d{4}-\d{4})-(\d)/);
  if (!m) return show;
  const term = m[2] === "2" ? "春季" : m[2] === "3" ? "夏季" : "秋季";
  return `${m[1]}学年${term}`;
}

export async function searchCourses(auth: AuthContext, keyword: string, page = 1, size = 15): Promise<CourseSearchResult> {
  const query = new URLSearchParams({ keyword, page: String(page), size: String(size), sort: "semester" });
  const res = await getJson(auth, `/learn/shanghai/tech/get/course?${query}`, CourseSearch);
  const data = res.data;
  return {
    total: data.total,
    page: data.page,
    size: data.size,
    courses: (data.results ?? []).map((r) => ({
      courseId: r.contentId_,
      name: r.name_,
      serialNumber: r.serialNumber?.trim() || null,
      courseNumber: r.courseNumber?.trim() || null,
      teachers: r.teacher_names ?? [],
      classTime: null,
      colleges: [],
      courseSemesterId: r.course_semester_id != null ? String(r.course_semester_id) : null,
      semester: semesterFromShow(r.semester_show_name) ?? null,
    })),
  };
}

// ---------------------------------------------------------------- other search scopes

export type SearchScope = "resources" | "knowledge" | "live" | "teachers";

export interface SearchItem {
  title: string;
  meta: string;
  ref: string;
}

const ResourceSearch = z
  .object({
    data: z
      .object({
        extendMessage: z
          .object({
            recordTotal: z.number().nullable().optional(),
            data: z
              .array(
                z
                  .object({
                    contentId: z.string().nullable().optional(),
                    name: z.string().nullable().optional(),
                    courseCode: z.string().nullable().optional(),
                    courseName: z.string().nullable().optional(),
                    courseTeachers: z.string().nullable().optional(),
                    resourceFormat: z.string().nullable().optional(),
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
      .loose(),
  })
  .loose();

const KnowledgeSearch = z
  .object({
    data: z
      .object({
        total: z.number().nullable().optional(),
        results: z
          .array(
            z
              .object({
                name_: z.string().nullable().optional(),
                course_id: z.string().nullable().optional(),
                teacherCodes: z.array(z.string()).nullable().optional(),
                courseType: z.number().nullable().optional(),
              })
              .loose(),
          )
          .nullable()
          .optional(),
      })
      .loose(),
  })
  .loose();

const LiveSearch = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.string().nullable().optional(),
            liveName: z.string().nullable().optional(),
            liveSpeaker: z.string().nullable().optional(),
            scheduleStatus: z.number().nullable().optional(),
          })
          .loose(),
      )
      .nullable()
      .optional(),
  })
  .loose();

const TeacherSearch = z
  .object({
    data: z
      .object({
        total: z.number().nullable().optional(),
        results: z
          .array(
            z
              .object({
                nickName: z.string().nullable().optional(),
                userCode: z.string().nullable().optional(),
                college: z.string().nullable().optional(),
              })
              .loose(),
          )
          .nullable()
          .optional(),
      })
      .loose(),
  })
  .loose();

export async function searchOther(
  auth: AuthContext,
  scope: SearchScope,
  query: string,
  page = 1,
  size = 10,
  source: "EYun" | "Blackboard" | "Mooc" = "EYun",
): Promise<{ total: number | null; items: SearchItem[] }> {
  if (scope === "resources") {
    const path = `/rman/v1/resourcecentre/searchteachingresource?page=${page}&size=${size}&keyword=${encodeURIComponent(query)}&publishYear=-1&isDefault=false&source=${source}`;
    const res = await getJson(auth, path, ResourceSearch);
    const em = res.data.extendMessage;
    return {
      total: em?.recordTotal ?? null,
      items: (em?.data ?? []).map((r) => ({
        title: r.name ?? "",
        meta: [r.courseCode, r.courseName, r.courseTeachers, r.resourceFormat].filter(Boolean).join(" | "),
        ref: r.contentId ?? "",
      })),
    };
  }
  if (scope === "knowledge") {
    const path = `/learn/v1/search/history/knowledge/point?name=${encodeURIComponent(query)}&wholeMatch=false&page=${page}&size=${size}`;
    const res = await getJson(auth, path, KnowledgeSearch);
    return {
      total: res.data.total ?? null,
      items: (res.data.results ?? []).map((r) => ({
        title: r.name_ ?? "",
        meta: [r.teacherCodes?.join("/"), r.course_id ? `course=${r.course_id}` : ""].filter(Boolean).join(" | "),
        ref: r.course_id ?? "",
      })),
    };
  }
  if (scope === "live") {
    const path = `/learn/v1/search/history/search/live?name=${encodeURIComponent(query)}&page=${page}&size=${size}`;
    const res = await getJson(auth, path, LiveSearch);
    return {
      total: (res.data ?? []).length,
      items: (res.data ?? []).map((r) => ({
        title: r.liveName ?? "",
        meta: [r.liveSpeaker, r.scheduleStatus != null ? `状态 ${r.scheduleStatus}` : ""].filter(Boolean).join(" | "),
        ref: r.id ?? "",
      })),
    };
  }
  const path = `/learn/v1/search/history/search/teacher?name=${encodeURIComponent(query)}&page=${page}&size=${size}&wholeMatch=false`;
  const res = await getJson(auth, path, TeacherSearch);
  return {
    total: res.data.total ?? null,
    items: (res.data.results ?? []).map((r) => ({
      title: r.nickName ?? "",
      meta: r.college ?? "",
      ref: r.userCode ?? "",
    })),
  };
}
