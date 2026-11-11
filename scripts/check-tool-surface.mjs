#!/usr/bin/env node
/**
 * MCP tool-surface linter — enforces docs/MCP-TOOL-CONVENTIONS.md.
 *
 * Usage:
 *   node scripts/check-tool-surface.mjs [url]
 *   MCP_AUTH_TOKEN=… node scripts/check-tool-surface.mjs https://host/api/mcp
 *
 * Exit codes: 0 = no errors (warnings allowed), 1 = errors.
 */
const url = process.argv[2] ?? process.env.MCP_URL ?? "http://127.0.0.1:3000/api/mcp";
const token = process.env.MCP_AUTH_TOKEN;

const PLATFORMS = new Set(["coursebench", "eams", "egate", "libspace", "oa", "elearning", "campus", "ids", "ecourse"]);
const NAME_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const TOTAL_BUDGET = 25;
const PLATFORM_BUDGET = 6;

const errors = [];
const warnings = [];
const err = (tool, msg) => errors.push(`${tool}: ${msg}`);
const warn = (tool, msg) => warnings.push(`${tool}: ${msg}`);

function parseSseOrJson(body) {
  const line = body.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : body);
}

const headers = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
if (token) headers.authorization = `Bearer ${token}`;

let payload;
try {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  payload = parseSseOrJson(await res.text());
} catch (cause) {
  console.error(`cannot reach ${url}: ${cause.message}`);
  process.exit(2);
}

const tools = payload?.result?.tools;
if (!Array.isArray(tools)) {
  console.error("unexpected response:", JSON.stringify(payload).slice(0, 300));
  process.exit(2);
}

const perPlatform = new Map();
for (const tool of tools) {
  const name = tool.name ?? "<unnamed>";
  const prefix = name.split("_")[0];
  perPlatform.set(prefix, (perPlatform.get(prefix) ?? 0) + 1);

  if (!NAME_RE.test(name)) err(name, "name must match ^[a-z][a-z0-9]*(_[a-z0-9]+)+$");
  const segments = name.split("_").length;
  if (segments < 2 || segments > 5) err(name, `name has ${segments} segments (allowed 2–5)`);
  if (!PLATFORMS.has(prefix)) err(name, `unknown platform prefix "${prefix}"`);

  if (!tool.title || String(tool.title).trim() === "") err(name, "missing title");
  else if (String(tool.title).length > 40) warn(name, `title is ${String(tool.title).length} chars (keep ≤40)`);

  const desc = String(tool.description ?? "");
  if (desc.length < 12) err(name, `description too short (${desc.length} chars, need >=12)`);
  if (desc.length > 400) warn(name, `description is ${desc.length} chars (keep ≤400; move detail to resources)`);

  const annotations = tool.annotations ?? {};
  if (typeof annotations.readOnlyHint !== "boolean") err(name, "annotations.readOnlyHint must be explicit");

  const schema = tool.inputSchema ?? {};
  const props = schema.properties ?? {};
  for (const [key, value] of Object.entries(props)) {
    if (!value || typeof value.description !== "string" || value.description.trim() === "") {
      err(name, `inputSchema.${key} has no description`);
    }
  }

  const isWrite = annotations.readOnlyHint === false;
  if (isWrite) {
    if (!("confirm" in props)) err(name, "write tool must expose a `confirm` boolean");
    if (typeof annotations.destructiveHint !== "boolean") err(name, "write tool must state destructiveHint explicitly");
    // destructiveHint is only mandatory for actions that remove/overwrite state.
    const removesState = /(cancel|delete|remove|action|do$)/.test(name);
    if (removesState && annotations.destructiveHint !== true) {
      err(name, "cancel/delete style tool must set destructiveHint: true");
    }
    if (!/写|提交|创建|取消|签到|延长|动作/.test(desc)) warn(name, "write tool description should say it writes");
  } else if (annotations.readOnlyHint !== true) {
    err(name, "read tool must set readOnlyHint: true");
  }

  const hasOutput = Boolean(tool.outputSchema);
  if (!hasOutput && !isWrite) warn(name, "no outputSchema/structuredContent (conventions §5)");
}

if (tools.length > TOTAL_BUDGET) err("<surface>", `${tools.length} tools exceeds budget ${TOTAL_BUDGET}`);
for (const [prefix, count] of perPlatform) {
  if (count > PLATFORM_BUDGET) err(prefix, `${count} tools exceeds per-platform budget ${PLATFORM_BUDGET}`);
}

const width = 34;
console.log(`${tools.length} tools from ${url}`);
for (const [prefix, count] of [...perPlatform].sort()) {
  console.log(`  ${prefix.padEnd(width)} ${count}`);
}
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  warn  ${w}`);
}
if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors) console.error(`  error ${e}`);
  process.exit(1);
}
console.log("\nOK");
