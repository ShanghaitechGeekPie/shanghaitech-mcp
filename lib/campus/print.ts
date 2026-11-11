import { z } from "zod";

/**
 * 校园文印平台 (`PRINT_BASE_URL`, default the campus LAN box).
 *
 * NOT CAS: it has its own account system, but the username/password are the
 * same as IDS. Verified contract (2026-11-11):
 *   POST /v1/base_account/login {username,password}   → data.token (JWT, ~7d)
 *   POST /v1/task/pending/uploadPrintFile?source=web  multipart field `file`
 *        header `x-token: <JWT>`                      → {uuid, printCode}
 *   GET  /v1/task/pending/getPrintTaskList?pageNum=&pageSize=
 *   PUT  /v1/task/pending/updateTaskByUUId
 *   DELETE /v1/task/pending/deleteTaskByIds  body {"uuids":[...]}
 *
 * The host is campus-LAN only (10.x): Vercel cannot reach it; a client on
 * campus can POST to it directly (CORS reflects the Origin and allows X-Token).
 */

export const PRINT_BASE = (process.env.PRINT_BASE_URL ?? "http://10.15.21.225").replace(/\/+$/, "");

export class PrintError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "PrintError";
  }
}

const Envelope = z.object({ code: z.number(), data: z.unknown().nullish(), msg: z.string().optional() }).loose();

function tokenExpiry(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: number };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export interface PrintLoginResult {
  token: string;
  expiresAt: number | null;
}

export async function printLogin(username: string, password: string): Promise<PrintLoginResult> {
  const res = await fetch(`${PRINT_BASE}/v1/base_account/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(10_000),
  });
  const parsed = Envelope.safeParse(await res.json());
  if (!parsed.success) throw new PrintError(`文印系统登录响应异常（HTTP ${res.status}）`, "bad_payload");
  if (parsed.data.code !== 0) throw new PrintError(parsed.data.msg ?? `文印系统登录失败（code=${parsed.data.code}）`, "login_failed");

  const data = parsed.data.data as { token?: string } | null;
  const token = data?.token;
  if (!token) throw new PrintError("文印系统登录成功但未返回 token", "bad_payload");
  return { token, expiresAt: tokenExpiry(token) };
}

export interface PrintUploadResult {
  uuid: string;
  printCode: string;
}

export async function printUpload(token: string, bytes: Uint8Array<ArrayBuffer>, name: string, mime: string): Promise<PrintUploadResult> {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), name);
  const res = await fetch(`${PRINT_BASE}/v1/task/pending/uploadPrintFile?source=web`, {
    method: "POST",
    headers: { "x-token": token },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const parsed = Envelope.safeParse(await res.json());
  if (!parsed.success) throw new PrintError(`文印系统上传响应异常（HTTP ${res.status}）`, "bad_payload");
  if (parsed.data.code !== 0) throw new PrintError(parsed.data.msg ?? `上传失败（code=${parsed.data.code}）`, "upload_failed");
  const data = parsed.data.data as { uuid?: string; printCode?: string } | null;
  if (!data?.uuid || !data.printCode) throw new PrintError("上传成功但缺少 uuid/打印码", "bad_payload");
  return { uuid: data.uuid, printCode: String(data.printCode) };
}

export interface PrintTask {
  uuid: string;
  name: string;
  printCode: string | null;
  status: number | null;
  createdAt: string | null;
}

const TaskList = z
  .object({
    code: z.number(),
    data: z.object({ list: z.array(z.record(z.string(), z.unknown())).nullable().optional() }).loose().nullish(),
    msg: z.string().optional(),
  })
  .loose();

export async function printTasks(token: string, pageNum = 1, pageSize = 20, kind: "print" | "scan" = "print"): Promise<PrintTask[]> {
  const path = kind === "print" ? "getPrintTaskList" : "getScanTaskList";
  const res = await fetch(`${PRINT_BASE}/v1/task/pending/${path}?pageNum=${pageNum}&pageSize=${pageSize}`, {
    headers: { "x-token": token },
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = TaskList.safeParse(await res.json());
  if (!parsed.success) throw new PrintError(`文印任务列表响应异常（HTTP ${res.status}）`, "bad_payload");
  if (parsed.data.code !== 0) throw new PrintError(parsed.data.msg ?? "查询文印任务失败", "list_failed");
  return (parsed.data.data?.list ?? []).map((r) => ({
    uuid: String(r.uuid ?? ""),
    name: String(r.name ?? ""),
    printCode: r.printCode != null ? String(r.printCode) : null,
    status: typeof r.status === "number" ? r.status : null,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : null,
  }));
}

export async function printDelete(token: string, uuids: string[]): Promise<void> {
  const res = await fetch(`${PRINT_BASE}/v1/task/pending/deleteTaskByIds`, {
    method: "DELETE",
    headers: { "x-token": token, "content-type": "application/json" },
    body: JSON.stringify({ uuids }),
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = Envelope.safeParse(await res.json());
  if (!parsed.success || parsed.data.code !== 0) {
    throw new PrintError(parsed.success ? (parsed.data.msg ?? "删除失败") : "删除响应异常", "delete_failed");
  }
}
