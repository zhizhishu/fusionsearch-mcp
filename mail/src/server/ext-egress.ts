// 对外「出口」(egress)：ClawEmail 自己长出一套 cloudflare_temp_email 格式的 API，
// 把 claw 子邮箱 + 临时邮箱(php/cf)统一对外吐出去。任何 cf_temp_email 客户端/脚本
// 填「服务地址 + 后台口令(+站点口令) + 域名」就能建址 / 读信。
//
// 鉴权三层（对齐真项目 dreamhunter2333/cloudflare_temp_email）：
//   - x-admin-auth : 出口后台口令（建址、列地址）—— 本出口自己的 token，非面板 ADMIN_PASSWORD
//   - Authorization: Bearer <jwt> : 每个地址的签名令牌（读该地址的信）
//   - x-custom-auth : 站点口令（可选；设了就每个请求都要带）
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSetting, setSetting, deleteSettings, listMailboxes, getMailboxByEmail } from "./db";
import { getDomain, getRootPrefix, hasClawMailConfig } from "./runtime-config";
import { listProviders, getProvider } from "./temp-providers";
import { createMailbox as createClawMailbox } from "./claw-dashboard";
import { listRemoteInboxMessageIds, readRemoteMail, sendMail as clawSendMail, getMailClient } from "./claw-mail";
import { cfCreateAlias, cfInboxRich, cfMessage, cfListAliases, cfSend } from "./cf-mail";

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");
const localOf = (addr: string) => addr.split("@")[0]!.trim().toLowerCase();
const randomLocal = () => "u" + randomBytes(5).toString("hex");

// ---------- 口令 / 密钥（存 app_settings，随 Supabase 持久化）----------
export function getExtAdminToken(): string {
  let t = getSetting("ext.adminToken");
  if (!t) { t = "cae_out_" + randomBytes(18).toString("base64url"); setSetting("ext.adminToken", t); }
  return t;
}
export function regenExtAdminToken(): string {
  const t = "cae_out_" + randomBytes(18).toString("base64url");
  setSetting("ext.adminToken", t);
  return t;
}
export function getExtSitePassword(): string { return getSetting("ext.sitePassword") ?? ""; }
export function setExtSitePassword(v: string): void {
  const t = (v ?? "").trim();
  // 清空=删除键（不存空串）：否则空值在 Supabase 不可靠，重启 hydrate 会被旧值灌回。
  if (t) setSetting("ext.sitePassword", t);
  else deleteSettings(["ext.sitePassword"]);
}

function jwtSecret(): string {
  let s = getSetting("ext.jwtSecret");
  if (!s) { s = randomBytes(32).toString("base64url"); setSetting("ext.jwtSecret", s); }
  return s;
}

// ---------- 到信 webhook（给"别的项目当邮件后端"免轮询）----------
export function getExtWebhookUrl(): string { return getSetting("ext.webhookUrl") ?? ""; }
export function setExtWebhookUrl(v: string): void {
  const t = (v ?? "").trim();
  if (t) setSetting("ext.webhookUrl", t); else deleteSettings(["ext.webhookUrl"]);
}
// 收到新邮件时 POST 回调外部 URL。失败只记日志不抛、不影响收信。
export async function notifyWebhook(payload: { mailbox: string; id: number; from?: string | null; subject?: string | null }): Promise<void> {
  const url = getExtWebhookUrl();
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "mail.received", address: payload.mailbox, ...payload })
    });
  } catch (e) {
    console.warn("[ext webhook] post failed:", e instanceof Error ? e.message : String(e));
  }
}

// ---------- 发信日限额（出口防滥用/防 claw 封号；默认 200/天，设 0 关闭）----------
export function getExtSendLimit(): number {
  const v = getSetting("ext.sendLimit");
  return v == null ? 200 : Number(v) || 0;
}
export function setExtSendLimit(n: number): void { setSetting("ext.sendLimit", String(Math.max(0, Math.floor(n)))); }
function checkSendQuota(): void {
  const limit = getExtSendLimit();
  if (!limit) return; // 0 = 不限
  const today = new Date().toISOString().slice(0, 10);
  const count = getSetting("ext.sendDay") === today ? Number(getSetting("ext.sendCount") || "0") : 0;
  if (count >= limit) throw new Error(`出口今日发信已达上限 ${limit} 封（防滥用/防封号；可在设置「对外出口」调整或设 0 关闭）`);
  setSetting("ext.sendDay", today);
  setSetting("ext.sendCount", String(count + 1));
}

// ---------- 附件下载（claw 子邮箱；临时邮箱暂不支持）----------
export async function extAttachment(p: AddrPayload, mailId: string, partId: string): Promise<{ contentType: string; filename: string; stream: () => NodeJS.ReadableStream }> {
  if (p.b !== "claw") throw new Error("临时邮箱暂不支持出口附件下载");
  const att = await getMailClient(p.a).mail.getAttachment({ id: mailId, part: partId });
  return { contentType: att.contentType || "application/octet-stream", filename: att.filename || "attachment", stream: att.stream };
}

// ---------- 每址签名令牌（无状态，HMAC-SHA256）----------
type AddrPayload = { a: string; b: "claw" | "temp"; p?: string; l?: string };

export function signAddrToken(payload: AddrPayload): string {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac("sha256", jwtSecret()).update(body).digest());
  return `${body}.${sig}`;
}
export function verifyAddrToken(token: string): AddrPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expect = b64url(createHmac("sha256", jwtSecret()).update(body!).digest());
  const A = Buffer.from(sig!); const B = Buffer.from(expect);
  if (A.length !== B.length || !timingSafeEqual(A, B)) return null;
  try { return JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as AddrPayload; }
  catch { return null; }
}

export function hashAddressId(address: string): number {
  let h = 2166136261;
  for (let i = 0; i < address.length; i++) { h ^= address.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 2000000000) + 1;
}

// ---------- 域名 ----------
export function clawDomain(): string | null {
  return hasClawMailConfig() ? getDomain() : null;
}
export function allDomains(): string[] {
  const out: string[] = [];
  const cd = clawDomain();
  if (cd) out.push(cd);
  for (const p of listProviders()) if (p.domain && !out.includes(p.domain)) out.push(p.domain);
  return out;
}

// ---------- 建址：按域名分流到 claw 或临时 provider ----------
export async function extCreateAddress(
  name: string | undefined,
  domain: string
): Promise<{ address: string; jwt: string; address_id: number }> {
  const d = domain.trim().toLowerCase();
  const local = name && name.trim() ? name.trim().toLowerCase() : randomLocal();

  const cd = clawDomain();
  if (cd && d === cd.toLowerCase()) {
    const mb = await createClawMailbox(local);
    return { address: mb.email, jwt: signAddrToken({ a: mb.email, b: "claw" }), address_id: hashAddressId(mb.email) };
  }

  const provider = listProviders().find((p) => p.domain.trim().toLowerCase() === d);
  if (!provider) throw new Error(`unknown domain: ${domain}`);
  const alias = await cfCreateAlias(provider, local);
  const payload: AddrPayload = { a: alias.address, b: "temp", p: provider.id, l: alias.local || localOf(alias.address) };
  return { address: alias.address, jwt: signAddrToken(payload), address_id: hashAddressId(alias.address) };
}

// ---------- 读信：claw 走活读，temp 走 cfInbox，统一成 cf 字段 ----------
export type ExtAttachmentMeta = { id: string; filename: string | null; contentType: string | null; size: number | null };
export type ExtMail = {
  id: string | number;
  raw: string;
  from_address: string;
  to_address: string;
  subject: string;
  message: string;
  html: string | null;
  created_at: string | null;
  attachments?: ExtAttachmentMeta[];
};

export async function extReadMails(p: AddrPayload, limit: number, offset: number): Promise<ExtMail[]> {
  if (p.b === "claw") {
    const ids = await listRemoteInboxMessageIds(p.a);
    const slice = ids.slice(offset, offset + limit);
    const out: ExtMail[] = [];
    for (const id of slice) {
      const m = (await readRemoteMail(p.a, id)) as any;
      const text: string = m.text?.content ?? "";
      const header: string = m.headerRaw ?? "";
      out.push({
        id,
        raw: header ? `${header}\n\n${text}` : text,
        from_address: m.from?.[0] ?? "",
        to_address: m.to?.[0] ?? p.a,
        subject: m.subject ?? "",
        message: text || (m.html?.content ?? ""),
        html: m.html?.content ?? null,
        created_at: m.date ?? null
      });
    }
    return out;
  }
  const provider = getProvider(p.p);
  if (!provider) throw new Error("temp provider not found");
  // 列表也对齐 canonical：带全量 text+html（cf 零额外往返；php 切片后逐封补全量），不再只给 preview 截断
  const mails = await cfInboxRich(provider, p.l ?? localOf(p.a), limit, offset);
  return mails.map((m) => ({
    id: m.uid,
    raw: m.bodyHtml ?? m.bodyText ?? "",
    from_address: m.from ?? "",
    to_address: m.to ?? p.a,
    subject: m.subject ?? "",
    message: m.bodyText ?? m.preview ?? "",
    html: m.bodyHtml ?? null,
    created_at: m.date ?? null
  }));
}

// ---------- 发信：按地址域名分流（claw 走 SDK 无需 SMTP；临时走 cfSend）----------
export function payloadForAddress(address: string): AddrPayload {
  const dom = address.split("@")[1]?.trim().toLowerCase() ?? "";
  const cd = clawDomain();
  if (cd && dom === cd.toLowerCase()) return { a: address, b: "claw" };
  const provider = listProviders().find((p) => p.domain.trim().toLowerCase() === dom);
  if (provider) return { a: address, b: "temp", p: provider.id, l: localOf(address) };
  throw new Error(`未知发件域名：${dom}`);
}

// 管理员指定任意地址(show_password/admin mails/admin send)时校验：该地址确属本账号——
// 临时域是用户自建 provider(放行)；claw 地址必须本面板已建、或本账号根前缀下的子地址。
// 防出口后台口令被用来读/冒发同 claw 工作区里非本面板管理的任意子邮箱。
export function assertManagedAddress(address: string): void {
  const p = payloadForAddress(address); // 先过域名门：非 claw/temp 域直接 throw
  if (p.b !== "claw") return;
  const addr = address.trim().toLowerCase();
  if (getMailboxByEmail(addr)) return;
  const root = (getRootPrefix() || "").toLowerCase();
  const local = (addr.split("@")[0] ?? "");
  if (root && (local === root || local.startsWith(`${root}.`))) return;
  throw new Error(`地址 ${address} 不在本账号管理范围`);
}

export async function extSendMail(
  p: AddrPayload,
  input: { to: string[]; subject?: string; content?: string; html?: boolean }
): Promise<{ status: string }> {
  const to = (input.to ?? []).map((s) => s.trim()).filter(Boolean);
  if (!to.length) throw new Error("收件人(to_mail)不能为空");
  checkSendQuota(); // 出口发信日限额，防滥用/防 claw 封号
  if (p.b === "claw") {
    // claw 子邮箱经账号 SDK 直接发，无需外部 SMTP
    await clawSendMail({ from: p.a, to, subject: input.subject, body: input.content, html: input.html });
    return { status: "ok" }; // canonical cf send 响应
  }
  const provider = getProvider(p.p);
  if (!provider) throw new Error("临时邮箱源不存在");
  await cfSend(provider, { from: p.a, to, subject: input.subject, body: input.content, html: input.html });
  return { status: "ok" }; // canonical cf send 响应
}

// ---------- 读单封（每址 jwt：/api/mail/:id, /api/parsed_mail/:id）----------
export async function extReadSingle(p: AddrPayload, mailId: string): Promise<ExtMail | null> {
  if (p.b === "claw") {
    const m = (await readRemoteMail(p.a, mailId)) as any;
    const text: string = m.text?.content ?? "";
    const header: string = m.headerRaw ?? "";
    return {
      id: mailId,
      raw: header ? `${header}\n\n${text}` : text,
      from_address: m.from?.[0] ?? "",
      to_address: m.to?.[0] ?? p.a,
      subject: m.subject ?? "",
      message: text || (m.html?.content ?? ""),
      html: m.html?.content ?? null,
      created_at: m.date ?? null,
      attachments: (m.attachments ?? []).map((a: any) => ({
        id: a.id, filename: a.filename ?? null, contentType: a.contentType ?? null, size: a.contentLength ?? a.size ?? null
      }))
    };
  }
  const provider = getProvider(p.p);
  if (!provider) throw new Error("temp provider not found");
  const d = (await cfMessage(provider, p.l ?? localOf(p.a), Number(mailId))) as any;
  const body: string = d.bodyText ?? d.preview ?? "";
  return {
    id: mailId,
    raw: d.bodyHtml ?? body,
    from_address: d.from ?? "",
    to_address: d.to ?? p.a,
    subject: d.subject ?? "",
    message: body,
    html: d.bodyHtml ?? null,
    created_at: d.date ?? null
  };
}

// ---------- 列出已知地址（claw 已建 + 各临时源别名）----------
export async function extListAddresses(): Promise<Array<{ name: string; address: string; created_at: string | null; type: string }>> {
  const results: Array<{ name: string; address: string; created_at: string | null; type: string }> = [];
  for (const mb of listMailboxes()) {
    results.push({ name: mb.email.split("@")[0]!, address: mb.email, created_at: (mb as any).created_at ?? null, type: "claw" });
  }
  for (const p of listProviders()) {
    try {
      for (const a of await cfListAliases(p)) {
        results.push({ name: a.local, address: a.address, created_at: a.createdAt ?? null, type: `temp:${p.id}` });
      }
    } catch { /* 单源失败不影响整体 */ }
  }
  return results;
}
