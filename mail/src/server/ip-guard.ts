// IP 访问控制：登录失败 N 次自动封禁该 IP、手动黑名单、白名单(永不封/永不挡)。
// 状态存 app_settings（随 Supabase 持久化，重启不丢）。被封/黑名单的 IP 连页面都打不开。
import { getSetting, setSetting } from "./db";

export const FAIL_LIMIT = 3;

export type BanEntry = { ip: string; at: number; reason: string };

function readList(key: string): string[] {
  try { const v = getSetting(key); return v ? (JSON.parse(v) as string[]) : []; } catch { return []; }
}
function writeList(key: string, list: string[]): void {
  setSetting(key, JSON.stringify(Array.from(new Set(list.filter(Boolean)))));
}
function readBanned(): BanEntry[] {
  try { const v = getSetting("ip.banned"); return v ? (JSON.parse(v) as BanEntry[]) : []; } catch { return []; }
}
function writeBanned(list: BanEntry[]): void { setSetting("ip.banned", JSON.stringify(list)); }
function readFails(): Record<string, number> {
  try { const v = getSetting("ip.fails"); return v ? (JSON.parse(v) as Record<string, number>) : {}; } catch { return {}; }
}
function writeFails(m: Record<string, number>): void { setSetting("ip.fails", JSON.stringify(m)); }

// 取真实客户端 IP：用 Fastify 按 trustProxy(只信 1 跳反代)解析后的 req.ip，
// 不再手撸 x-forwarded-for 最左段——最左段最靠近客户端、最易伪造，会被用来绕过封禁/栽赃。
// req.ip 在 trustProxy:1 下只采信"最近一跳可信反代"添加的那一段，伪造头无效。
export function getClientIp(req: any): string {
  return req.ip || "unknown";
}

export function isWhitelisted(ip: string): boolean { return readList("ip.whitelist").includes(ip); }
export function isBlocked(ip: string): boolean {
  if (isWhitelisted(ip)) return false;
  if (readList("ip.blacklist").includes(ip)) return true;
  return readBanned().some((b) => b.ip === ip);
}

export function recordFail(ip: string): number {
  if (isWhitelisted(ip)) return 0;
  const m = readFails();
  m[ip] = (m[ip] || 0) + 1;
  writeFails(m);
  if (m[ip] >= FAIL_LIMIT) banIp(ip, `登录失败 ${m[ip]} 次自动封禁`);
  return m[ip];
}
export function clearFails(ip: string): void {
  const m = readFails();
  if (m[ip] !== undefined) { delete m[ip]; writeFails(m); }
}
export function banIp(ip: string, reason: string): void {
  const list = readBanned();
  if (!list.some((b) => b.ip === ip)) { list.push({ ip, at: Date.now(), reason }); writeBanned(list); }
}
export function unbanIp(ip: string): void {
  writeBanned(readBanned().filter((b) => b.ip !== ip));
  clearFails(ip);
}
export function addWhitelist(ip: string): void { writeList("ip.whitelist", [...readList("ip.whitelist"), ip]); unbanIp(ip); }
export function delWhitelist(ip: string): void { writeList("ip.whitelist", readList("ip.whitelist").filter((x) => x !== ip)); }
export function addBlacklist(ip: string): void { writeList("ip.blacklist", [...readList("ip.blacklist"), ip]); }
export function delBlacklist(ip: string): void { writeList("ip.blacklist", readList("ip.blacklist").filter((x) => x !== ip)); }

export function accessState() {
  return {
    failLimit: FAIL_LIMIT,
    whitelist: readList("ip.whitelist"),
    blacklist: readList("ip.blacklist"),
    banned: readBanned(),
    fails: readFails()
  };
}
