import { z } from "zod";
import { authOptions, cookieAuth, follow, type AuthContext, type CookieJar } from "./http";
import { CampusSessionExpired } from "./eams";

/**
 * eCourse (TronClass) adapter — session layer.
 *
 * Verified chain (2026-11-11, unauthenticated probe):
 *   GET https://ecourse.shanghaitech.edu.cn/login
 *     → 302 https://ecourse.shanghaitech.edu.cn:8600/auth/realms/shanghaitech/protocol/cas/login
 *           ?ui_locales=zh-CN&service=http%3A//ecourse.shanghaitech.edu.cn/login
 *     → 302 ids…/authserver/login?service=<keycloak cas endpoint>
 *     → (CASTGC valid) 302 … broker/cas-client … 302 back to ecourse /login
 *     → ecourse sets `session=V2-…` (HttpOnly, SameSite=Lax) — the TronClass session
 *
 * Keycloak has no usable client credentials for us (the realm exposes device flow
 * but still needs an interactive login), so the only way in is a CASTGC bounce.
 * Cookies must be replayed manually: `session` is Path=/ and HttpOnly, and the
 * intermediate hops set/clear `role_token`.
 */

export const ECOURSE_BASE = (process.env.ECOURSE_BASE_URL ?? "https://ecourse.shanghaitech.edu.cn").replace(/\/+$/, "");

export const KEYCLOAK_CAS_PREFIX = "https://ecourse.shanghaitech.edu.cn:8600/auth/realms/shanghaitech/protocol/cas";

/** CASTGC → TronClass session cookies. */
export async function deriveEcourseSession(root: CookieJar): Promise<AuthContext> {
  const entry = await follow(`${ECOURSE_BASE}/login`, authOptions(cookieAuth(root), { maxHops: 12 }));
  const landed = new URL(entry.url);

  if (landed.hostname === "ids.shanghaitech.edu.cn" || entry.text.includes("统一身份认证")) {
    throw new CampusSessionExpired("ecourse 被重定向回 IDS 登录页，CASTGC 已失效，请重新 ids_login");
  }
  if (!landed.hostname.endsWith("ecourse.shanghaitech.edu.cn") || !entry.jar.session) {
    throw new CampusSessionExpired(`ecourse 未下发 session cookie（停在 ${landed.host}${landed.pathname}）`);
  }
  return cookieAuth(entry.jar);
}

// ---------------------------------------------------------------- API surface
// Verified live 2026-11-11 with a derived session:
//   GET /api/my-courses                     → {courses:[…]}
//   GET /api/courses/{id}/activities        → {activities:[…]}  (homework + material)
//   GET /api/courses/{id}/exams             → {exams:[…]}       (rows carry start/end)
//   GET /api/course/{id}/enrollments        → {enrollments:[…]} (roles: instructor/assistant/student)
//   GET /api/uploads/{uploadId}/url         → {url:"…:8001/download/file/{key}?timestamp=&token="}
// Activities carry `uploads[]` for courseware; each upload has id/name/size and
// `allow_download`. The signed URL supports HTTP Range.

export class EcourseError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "EcourseError";
  }
}

const Envelope = z.object({ code: z.union([z.number(), z.string()]).optional(), message: z.string().optional() }).loose();

async function ecourseGet(auth: AuthContext, path: string): Promise<unknown> {
  const res = await follow(`${ECOURSE_BASE}${path}`, authOptions(auth, { maxHops: 2 }));
  if (res.url.includes("ids.shanghaitech.edu.cn") || res.text.includes("统一身份认证")) {
    throw new CampusSessionExpired("ecourse 会话已失效，请重新 ids_login");
  }
  if (res.status === 403) {
    const parsed = Envelope.safeParse(JSON.parse(res.text));
    throw new EcourseError(parsed.success ? (parsed.data.message ?? "无权限访问该资源") : "无权限访问该资源", "forbidden");
  }
  if (res.status !== 200) throw new EcourseError(`ecourse 返回 HTTP ${res.status}（${path}）`, String(res.status));
  if (!res.text.trimStart().startsWith("{") && !res.text.trimStart().startsWith("[")) {
    throw new EcourseError(`ecourse 返回非 JSON（${path}）`, "bad_payload");
  }
  return JSON.parse(res.text);
}

function parse<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new EcourseError(`${what} 响应结构与预期不符：${parsed.error.message.slice(0, 160)}`, "parse_drift");
  return parsed.data;
}

const Course = z
  .object({
    id: z.number(),
    name: z.string(),
    course_code: z.string().nullable().optional(),
    course_type: z.number().nullable().optional(),
    academic_year: z.object({ name: z.string() }).loose().nullable().optional(),
    department: z.object({ name: z.string() }).loose().nullable().optional(),
    instructors: z.array(z.object({ id: z.number(), name: z.string() }).loose()).nullable().optional(),
    course_attributes: z.object({ student_count: z.number().nullable().optional() }).loose().nullable().optional(),
  })
  .loose();
export type EcourseCourse = z.infer<typeof Course>;

const Upload = z
  .object({
    id: z.number(),
    name: z.string(),
    size: z.number().nullable().optional(),
    allow_download: z.boolean().nullable().optional(),
    type: z.string().nullable().optional(),
  })
  .loose();
export type EcourseUpload = z.infer<typeof Upload>;

const Activity = z
  .object({
    id: z.number(),
    type: z.string(),
    title: z.string(),
    start_time: z.string().nullable().optional(),
    end_time: z.string().nullable().optional(),
    is_closed: z.boolean().nullable().optional(),
    published: z.boolean().nullable().optional(),
    module_id: z.number().nullable().optional(),
    uploads: z.array(Upload).nullable().optional(),
    data: z.object({ description: z.string().nullable().optional() }).loose().nullable().optional(),
  })
  .loose();
export type EcourseActivity = z.infer<typeof Activity>;

const Exam = z
  .object({
    id: z.number(),
    title: z.string(),
    start_time: z.string().nullable().optional(),
    end_time: z.string().nullable().optional(),
    is_closed: z.boolean().nullable().optional(),
    exam_type: z.string().nullable().optional(),
  })
  .loose();
export type EcourseExam = z.infer<typeof Exam>;

const Enrollment = z
  .object({
    id: z.number(),
    roles: z.array(z.string()),
    user: z
      .object({
        name: z.string().nullable().optional(),
        user_no: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();
export type EcourseEnrollment = z.infer<typeof Enrollment>;

export async function listCourses(auth: AuthContext): Promise<EcourseCourse[]> {
  return parse(z.object({ courses: z.array(Course) }).loose(), await ecourseGet(auth, "/api/my-courses"), "my-courses").courses;
}

export async function listActivities(auth: AuthContext, courseId: number): Promise<EcourseActivity[]> {
  return parse(
    z.object({ activities: z.array(Activity) }).loose(),
    await ecourseGet(auth, `/api/courses/${courseId}/activities`),
    "activities",
  ).activities;
}

export async function listExams(auth: AuthContext, courseId: number): Promise<EcourseExam[]> {
  return parse(z.object({ exams: z.array(Exam) }).loose(), await ecourseGet(auth, `/api/courses/${courseId}/exams`), "exams").exams;
}

export async function listEnrollments(auth: AuthContext, courseId: number): Promise<EcourseEnrollment[]> {
  return parse(
    z.object({ enrollments: z.array(Enrollment) }).loose(),
    await ecourseGet(auth, `/api/course/${courseId}/enrollments`),
    "enrollments",
  ).enrollments;
}

export async function uploadInfo(auth: AuthContext, uploadId: number): Promise<EcourseUpload> {
  return parse(Upload, await ecourseGet(auth, `/api/uploads/${uploadId}`), "upload");
}

/** Resolve a short-lived signed download URL for a courseware upload. */
export async function uploadUrl(auth: AuthContext, uploadId: number): Promise<{ url: string; expiresAt: number | null }> {
  const raw = parse(z.object({ url: z.string().url() }).loose(), await ecourseGet(auth, `/api/uploads/${uploadId}/url`), "upload url");
  const ts = new URL(raw.url).searchParams.get("timestamp");
  return { url: raw.url, expiresAt: ts ? Number(ts) * 1000 : null };
}
