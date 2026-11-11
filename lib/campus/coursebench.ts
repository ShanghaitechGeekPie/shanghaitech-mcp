/**
 * Client for the public CourseBench API (course reviews, ratings, comments).
 * No authentication required, so it is usable from any deployment region.
 */

const BASE_URL = (process.env.COURSEBENCH_BASE_URL ?? "https://coursebench.zambar.dev").replace(/\/+$/, "");

export interface CourseSummary {
  id: number;
  name: string;
  code: string;
  institute: string;
  credit: number;
  /** Published rating dimensions, order is defined by CourseBench (site average, then per-group). */
  score: number[];
  comment_num: number;
}

export interface CourseTeacher {
  id: number;
  name: string;
}

export interface CourseGroup {
  id: number;
  code: string;
  score: number[];
  comment_num: number;
  teachers: CourseTeacher[];
}

export interface CourseDetail extends CourseSummary {
  groups: CourseGroup[];
}

export interface CourseComment {
  id: number;
  title: string;
  content: string;
}

interface ApiEnvelope<T> {
  error: boolean | string;
  data: T;
}

export class CourseBenchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CourseBenchError";
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { accept: "application/json", "user-agent": "shanghaitech-mcp" },
      signal: signal ?? AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new CourseBenchError(`CourseBench request failed: ${(cause as Error).message}`);
  }
  if (!res.ok) throw new CourseBenchError(`CourseBench returned HTTP ${res.status} for ${path}`);

  const body = (await res.json()) as ApiEnvelope<T> | T;
  if (body && typeof body === "object" && "data" in body && "error" in body) {
    const envelope = body as ApiEnvelope<T>;
    if (envelope.error) throw new CourseBenchError(`CourseBench error: ${String(envelope.error)}`);
    return envelope.data;
  }
  return body as T;
}

/** Average of the published rating dimensions, or null when unrated. */
export function averageScore(score: number[]): number | null {
  const valid = score.filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

export interface SearchCoursesOptions {
  query?: string;
  institute?: string;
  minScore?: number;
  limit?: number;
  signal?: AbortSignal;
}

export async function searchCourses(opts: SearchCoursesOptions = {}): Promise<CourseSummary[]> {
  const { query, institute, minScore, limit = 20, signal } = opts;
  const path = query && query.trim() ? `/v1/course/all?q=${encodeURIComponent(query.trim())}` : "/v1/course/all";
  const courses = await getJson<CourseSummary[]>(path, signal);

  const filtered = courses.filter((c) => {
    if (institute && !c.institute?.includes(institute)) return false;
    if (minScore !== undefined) {
      const avg = averageScore(c.score ?? []);
      if (avg === null || avg < minScore) return false;
    }
    return true;
  });

  return filtered.slice(0, Math.max(1, limit));
}

export function getCourse(courseId: number, signal?: AbortSignal): Promise<CourseDetail> {
  return getJson<CourseDetail>(`/v1/course/${courseId}`, signal);
}

export async function getCourseComments(courseId: number, limit = 10, signal?: AbortSignal): Promise<CourseComment[]> {
  const comments = await getJson<CourseComment[]>(`/v1/comment/course/${courseId}`, signal);
  return comments.slice(0, Math.max(1, limit));
}
