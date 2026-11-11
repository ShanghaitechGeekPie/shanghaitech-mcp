import { z } from "zod";
import { follow, type CookieJar } from "./http";
import { CampusSessionExpired } from "./eams";

/**
 * libspace (图书馆空间预约) adapter.
 *
 * Auth chain, verified live 2026-11-11:
 *   GET  /spaceReservationApp/api/login            → 302 IDS OAuth2 authorize
 *                                                    (client_id=1527260458833641472)
 *          → 302 ids…/authserver/login?service=<oauth callbackAuthorize>
 *          → 302 libspace…/login?code=…&state=…   (SPA route, nothing to render)
 *   GET  /spaceReservationApp/api/callBack?code&state
 *          → {"code":0,"data":{"access_token":"AT-…","expires_in":28800}}
 *   every API call: header `token: <access_token>`  (не Bearer)
 *
 * There is no cookie session for the API; the token is a bearer credential with
 * an 8h lifetime, derived per call from the root CASTGC.
 */

export const LIBSPACE_BASE = (
  process.env.LIBSPACE_BASE_URL ?? "https://libspace.shanghaitech.edu.cn/spaceReservationApp/api"
).replace(/\/+$/, "");

const SPACE_TYPES = ["DISCUSSION_ROOM", "STUDY_ROOM", "SILENT_BOOTH"] as const;
export type SpaceType = (typeof SPACE_TYPES)[number];

const Envelope = z.object({
  code: z.union([z.number(), z.string()]),
  data: z.unknown().nullable().optional(),
  msg: z.string().optional(),
});

export class LibspaceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "LibspaceError";
  }
}

/** CASTGC → libspace access token. Throws CampusSessionExpired when IDS rejects the TGC. */
export async function libspaceToken(root: CookieJar): Promise<string> {
  const login = await follow(`${LIBSPACE_BASE}/login`, { jar: root, maxHops: 12 });
  const landing = new URL(login.url);
  if (landing.hostname !== "libspace.shanghaitech.edu.cn") {
    throw new CampusSessionExpired("libspace 登录被重定向到非预期域名：" + landing.hostname);
  }
  const code = landing.searchParams.get("code");
  const state = landing.searchParams.get("state");
  if (!code || !state) throw new CampusSessionExpired("libspace 未返回 OAuth code（CASTGC 可能已失效）");

  const cb = await follow(`${LIBSPACE_BASE}/callBack?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
    jar: login.jar,
    maxHops: 2,
  });
  const parsed = Envelope.parse(JSON.parse(cb.text));
  if (String(parsed.code) === "40101") throw new CampusSessionExpired("libspace 拒绝签发 token，请重新 ids_login");
  if (String(parsed.code) !== "0") throw new LibspaceError(parsed.msg ?? "callBack 失败", String(parsed.code));

  const token = z.object({ access_token: z.string().min(8) }).safeParse(parsed.data);
  if (!token.success) throw new LibspaceError("callBack 返回缺少 access_token", "bad_payload");
  return token.data.access_token;
}

async function api<T>(
  token: string,
  path: string,
  schema: z.ZodType<T>,
  opts: { method?: "GET" | "POST"; query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(`${LIBSPACE_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await follow(url.toString(), {
    method: opts.method ?? "GET",
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    headers: { token, "content-type": "application/json" },
    maxHops: 2,
  });

  let envelope;
  try {
    envelope = Envelope.parse(JSON.parse(res.text));
  } catch {
    throw new LibspaceError(`libspace 返回非 JSON（HTTP ${res.status}）`, "bad_payload");
  }
  const code = String(envelope.code);
  if (code === "40101") throw new CampusSessionExpired("libspace token 已失效，请重新 ids_login");
  if (code !== "0") throw new LibspaceError(envelope.msg ?? `libspace code=${code}`, code);

  const parsed = schema.safeParse(envelope.data);
  if (!parsed.success) throw new LibspaceError(`libspace 响应结构与预期不符：${parsed.error.message.slice(0, 160)}`, "parse_drift");
  return parsed.data;
}

const Slot = z.object({ time: z.string(), statusCode: z.string() });
export type Slot = z.infer<typeof Slot>;

const Room = z
  .object({
    id: z.number(),
    spaceName: z.string(),
    typeCode: z.string(),
    floorNo: z.number().nullable().optional(),
    capacity: z.number().nullable().optional(),
    disabled: z.boolean().optional(),
    equipment: z.array(z.string()).nullable().optional(),
    facilities: z.array(z.string()).nullable().optional(),
    slots: z.array(Slot).nullable().optional(),
  })
  .loose();
export type Room = z.infer<typeof Room>;

const RoomPage = z.object({ list: z.array(Room), total: z.number().optional() }).loose();

export const SpaceConfig = z.object({
  cycleDays: z.number(),
  maxDurationHours: z.number(),
  minDurationHours: z.number(),
  openStartTime: z.string(),
  openEndTime: z.string(),
});

const Profile = z
  .object({
    userNo: z.string(),
    userName: z.string(),
    email: z.string().nullable().optional(),
    userType: z.string().optional(),
    violationCountList: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  })
  .loose();

const Reservation = z
  .object({
    reservationId: z.number(),
    spaceName: z.string(),
    reserveDate: z.string(),
    startTime: z.string(),
    endTime: z.string(),
    reservationStatus: z.string(),
    reservationStatusStr: z.string().optional(),
    canExtend: z.boolean().optional(),
    signInWindow: z.boolean().optional(),
    meetingTopic: z.string().nullable().optional(),
    participantsName: z.string().nullable().optional(),
  })
  .loose();
export type Reservation = z.infer<typeof Reservation>;

const ReservationPage = z.object({ list: z.array(Reservation), total: z.number().optional() }).loose();

const ExtendOptions = z
  .object({
    allow: z.boolean().optional(),
    maxExtendTimes: z.number().optional(),
    currentExtendTimes: z.number().optional(),
    options: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .loose();

export interface RoomQuery {
  date: string;
  type?: SpaceType;
  pageNo?: number;
  pageSize?: number;
}

/** Room list for a date. Without `type`, all three types are queried and merged. */
export async function listRooms(token: string, q: RoomQuery): Promise<Room[]> {
  const types: SpaceType[] = q.type ? [q.type] : [...SPACE_TYPES];
  const pages = await Promise.all(
    types.map((type) =>
      api(token, "/spaces", RoomPage, {
        query: { date: q.date, type, pageNo: q.pageNo ?? 1, pageSize: q.pageSize ?? 50 },
      }),
    ),
  );
  return pages.flatMap((p) => p.list);
}

export function openScope(token: string) {
  return api(token, "/spaces/open-scope", z.array(z.object({ spaceType: z.string(), openScope: z.string() }).loose()));
}

export function spaceConfig(token: string, spaceType: SpaceType) {
  return api(token, "/spaces/space-config", SpaceConfig.loose(), { query: { spaceType } });
}

export function floors(token: string, spaceType: SpaceType) {
  return api(token, "/spaces/floorList", z.array(z.object({ floorNo: z.number() }).loose()), { query: { spaceType } });
}

export function schedule(token: string, spaceId: number, date: string) {
  return api(token, `/spaces/${spaceId}/schedule`, z.object({ spaceId: z.number(), date: z.string(), slots: z.array(Slot) }).loose(), {
    query: { date },
  });
}

export function me(token: string) {
  return api(token, "/me", Profile);
}

export interface ReservationQuery {
  tab?: "current" | "history";
  pageNo?: number;
  pageSize?: number;
  type?: string;
  roomName?: string;
  statusCode?: string;
  dateStart?: string;
  dateEnd?: string;
}

export function reservations(token: string, q: ReservationQuery = {}) {
  const body = {
    tab: q.tab ?? "current",
    pageNo: q.pageNo ?? 1,
    pageSize: q.pageSize ?? 20,
    ...(q.type ? { type: q.type } : {}),
    ...(q.roomName ? { roomName: q.roomName } : {}),
    ...(q.statusCode ? { statusCode: q.statusCode } : {}),
    ...(q.dateStart && q.dateEnd ? { dateStart: q.dateStart, dateEnd: q.dateEnd } : {}),
  };
  return api(token, "/my/reservations/list", ReservationPage, { method: "POST", body });
}

export function reservation(token: string, reservationId: number) {
  return api(token, `/my/reservations/${reservationId}`, Reservation);
}

export function extendOptions(token: string, reservationId: number, endTime?: string) {
  return api(token, `/my/reservations/${reservationId}/extend-options`, ExtendOptions, {
    query: endTime ? { endTime } : undefined,
  });
}

export interface CreateReservation {
  spaceId: number;
  spaceType: SpaceType;
  dates: string[];
  startTime: string;
  endTime: string;
  continuous?: boolean;
  meetingType?: string;
  title?: string;
  inviterList?: Array<{ inviterName: string; inviterNo: string }>;
}

/** Write: returns the raw envelope so callers see the platform's own receipt. */
export async function createReservation(token: string, input: CreateReservation) {
  const res = await follow(`${LIBSPACE_BASE}/reservations`, {
    method: "POST",
    body: JSON.stringify({
      spaceId: input.spaceId,
      spaceType: input.spaceType,
      dates: input.dates,
      continuous: input.continuous ?? input.dates.length > 1,
      startTime: input.startTime,
      endTime: input.endTime,
      meetingType: input.meetingType ?? "",
      title: input.title ?? "",
      inviterList: input.inviterList ?? [],
    }),
    headers: { token, "content-type": "application/json" },
    maxHops: 2,
  });
  return res.text;
}

export type ReservationAction = "cancel" | "sign-in" | "end-early" | "extend";

export async function reservationAction(
  token: string,
  reservationId: number,
  action: ReservationAction,
  payload?: { hours?: number },
) {
  const body =
    action === "extend"
      ? JSON.stringify({ hours: payload?.hours })
      : action === "end-early"
        ? JSON.stringify({ reservationId })
        : "";
  const res = await follow(`${LIBSPACE_BASE}/my/reservations/${reservationId}/${action}`, {
    method: "POST",
    body,
    headers: { token, "content-type": "application/json" },
    maxHops: 2,
  });
  return res.text;
}

export function searchUsers(token: string, nameKeyWords: string) {
  return api(
    token,
    "/reservations/queryUsers",
    z.array(z.object({ userName: z.string(), userNo: z.string(), userDept: z.string().nullable().optional() }).loose()),
    { query: { nameKeyWords } },
  );
}
