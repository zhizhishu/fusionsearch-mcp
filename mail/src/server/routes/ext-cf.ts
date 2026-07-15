// 出口路由：
//   公开 /ext/*  —— cf_temp_email 格式对外 API，自带 token 门（不受面板 /api/ 守卫，因路径不以 /api/ 开头）
//   面板 /api/ext/config —— 受 ADMIN_PASSWORD 守卫，给设置页读/改出口口令
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  getExtAdminToken,
  regenExtAdminToken,
  getExtSitePassword,
  setExtSitePassword,
  getExtWebhookUrl,
  setExtWebhookUrl,
  getExtSendLimit,
  setExtSendLimit,
  extAttachment,
  verifyAddrToken,
  allDomains,
  extCreateAddress,
  extReadMails,
  extReadSingle,
  extListAddresses,
  extSendMail,
  payloadForAddress,
  assertManagedAddress,
  signAddrToken,
  hashAddressId
} from "../ext-egress";

// canonical cf 邮件对象（dreamhunter2333/cloudflare_temp_email）。严格对齐，不留旧字段名。
//   raw    : {id, message_id, source, address, raw, created_at}
//   parsed : {id, message_id, source, address, sender, subject, text, html, created_at, attachments}
const toRaw = (m: any) => ({ id: m.id, message_id: null, source: m.from_address, address: m.to_address, raw: m.raw, created_at: m.created_at });
const toParsed = (m: any) => ({ id: m.id, message_id: null, source: m.from_address, address: m.to_address, sender: m.from_address, subject: m.subject, text: m.message, html: m.html ?? null, created_at: m.created_at });

// 兼容 cloudflare_temp_email 的 send_mail 字段名差异
function parseSend(body: any): { to: string[]; subject?: string; content?: string; html?: boolean } {
  const raw = body.to_mail ?? body.to ?? body.toMail ?? body.to_address;
  const to = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
      : [];
  return {
    to,
    subject: body.subject,
    content: body.content ?? body.text ?? body.body ?? "",
    html: Boolean(body.is_html ?? body.html ?? false)
  };
}

function hdr(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
}

export async function extCfRoutes(app: FastifyInstance): Promise<void> {
  // 站点口令门（设了才校验）
  const siteGate = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const pw = getExtSitePassword();
    if (pw && hdr(req, "x-custom-auth") !== pw) {
      reply.code(401).send({ error: "site password required (x-custom-auth)" });
      return false;
    }
    return true;
  };
  const adminGate = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!siteGate(req, reply)) return false;
    if (hdr(req, "x-admin-auth") !== getExtAdminToken()) {
      reply.code(401).send({ error: "admin auth required (x-admin-auth)" });
      return false;
    }
    return true;
  };
  const bearer = (req: FastifyRequest, reply: FastifyReply) => {
    if (!siteGate(req, reply)) return null;
    const m = /^Bearer\s+(.+)$/i.exec(hdr(req, "authorization") ?? "");
    const payload = m ? verifyAddrToken(m[1]!) : null;
    if (!payload) {
      reply.code(401).send({ error: "invalid address jwt (Authorization: Bearer)" });
      return null;
    }
    return payload;
  };

  // ---- 公开出口 ----
  // 公开发现端点（对齐 canonical：无鉴权，让客户端先探 needAuth/domains/enableSendMail）
  app.get("/ext/open_api/settings", async () => {
    return { domains: allDomains(), prefix: "", needAuth: Boolean(getExtSitePassword()), enableSendMail: true };
  });

  const createHandler = (needAdmin: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (needAdmin ? !adminGate(req, reply) : !siteGate(req, reply)) return;
    const body = (req.body ?? {}) as { name?: string; domain?: string };
    const domain = body.domain?.trim() || allDomains()[0];
    if (!domain) return reply.code(400).send({ error: "domain required (no domain configured)" });
    try {
      const r = await extCreateAddress(body.name, domain);
      // canonical 建址响应：{jwt, address, password, address_id}（password 本实现不设地址密码，恒 null）
      return { jwt: r.jwt, address: r.address, password: null, address_id: r.address_id };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  app.post("/ext/admin/new_address", createHandler(true));
  app.post("/ext/api/new_address", createHandler(false));

  const readHandler = (parsed: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = bearer(req, reply);
    if (!payload) return;
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 50);
    const offset = Math.max(Number(q.offset) || 0, 0);
    try {
      const mails = await extReadMails(payload, limit, offset);
      const results = mails.map((m) => (parsed ? toParsed(m) : toRaw(m)));
      return { results, count: results.length };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  app.get("/ext/api/mails", readHandler(false));
  app.get("/ext/api/parsed_mails", readHandler(true));

  // 读单封（每址 jwt，对齐标准 /api/mail/:id、/api/parsed_mail/:id）
  const singleHandler = (parsed: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = bearer(req, reply);
    if (!payload) return;
    const { mail_id } = req.params as { mail_id: string };
    try {
      const m = await extReadSingle(payload, mail_id);
      if (!m) return reply.code(404).send({ error: "mail not found" });
      // canonical 附件元数据 {filename, mimeType, size}（+id 供本实现按 part 下载）
      const attachments = (m.attachments ?? []).map((a) => ({ id: a.id, filename: a.filename, mimeType: a.contentType, size: a.size }));
      return { ...(parsed ? toParsed(m) : toRaw(m)), attachments };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  app.get("/ext/api/mail/:mail_id", singleHandler(false));
  app.get("/ext/api/parsed_mail/:mail_id", singleHandler(true));

  // 附件下载（每址 jwt；claw 子邮箱）：part id 取自单封返回的 attachments[].id
  app.get("/ext/api/mail/:mail_id/attachment/:part_id", async (req, reply) => {
    const payload = bearer(req, reply);
    if (!payload) return;
    const { mail_id, part_id } = req.params as { mail_id: string; part_id: string };
    try {
      const att = await extAttachment(payload, mail_id, part_id);
      reply.header("content-type", att.contentType);
      reply.header("content-disposition", `attachment; filename="${encodeURIComponent(att.filename)}"`);
      return reply.send(att.stream());
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 管理员取某地址的每址令牌（对齐标准 /admin/show_password；用 ?address= 指定已有地址）
  app.get("/ext/admin/show_password", async (req, reply) => {
    if (!adminGate(req, reply)) return;
    const address = ((req.query as { address?: string }).address ?? "").trim();
    if (!address) return reply.code(400).send({ error: "address query required" });
    try {
      assertManagedAddress(address);
      return { address, jwt: signAddrToken(payloadForAddress(address)), address_id: hashAddressId(address) };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 管理员指定地址读信（对齐标准 /admin/mails；?address= 必填，?parsed=true 取解析版）
  app.get("/ext/admin/mails", async (req, reply) => {
    if (!adminGate(req, reply)) return;
    const q = req.query as { address?: string; limit?: string; offset?: string; parsed?: string };
    const address = (q.address ?? "").trim();
    if (!address) return reply.code(400).send({ error: "address query required" });
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 50);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const parsed = q.parsed === "true" || q.parsed === "1";
    try {
      assertManagedAddress(address);
      const mails = await extReadMails(payloadForAddress(address), limit, offset);
      const results = mails.map((m) => (parsed ? toParsed(m) : toRaw(m)));
      return { results, count: results.length };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 发信：每址 jwt 从自己地址发；admin 可指定 from 地址发
  app.post("/ext/api/send_mail", async (req, reply) => {
    const payload = bearer(req, reply);
    if (!payload) return;
    const input = parseSend(req.body ?? {});
    if (!input.to.length) return reply.code(400).send({ error: "to_mail required" });
    try {
      return await extSendMail(payload, input);
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  app.post("/ext/admin/send_mail", async (req, reply) => {
    if (!adminGate(req, reply)) return;
    const body = (req.body ?? {}) as any;
    const from = (body.from_mail ?? body.from ?? body.address ?? body.from_address)?.trim();
    if (!from) return reply.code(400).send({ error: "from address required" });
    const input = parseSend(body);
    if (!input.to.length) return reply.code(400).send({ error: "to_mail required" });
    try {
      assertManagedAddress(from); // 防 admin 任意指定 from 冒充本工作区其它子邮箱发信
      return await extSendMail(payloadForAddress(from), input);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/ext/api/settings", async (req, reply) => {
    const payload = bearer(req, reply);
    if (!payload) return;
    // canonical 用户 settings：{address, send_balance}
    return { address: payload.a, send_balance: 0 };
  });

  app.get("/ext/admin/address", async (req, reply) => {
    if (!adminGate(req, reply)) return;
    try {
      const results = await extListAddresses();
      return { results, count: results.length };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ---- 面板侧管理（受 ADMIN_PASSWORD 门）----
  const view = () => ({
    pathPrefix: "/ext",
    adminToken: getExtAdminToken(),
    sitePassword: getExtSitePassword(),
    webhookUrl: getExtWebhookUrl(),
    sendLimit: getExtSendLimit(),
    domains: allDomains()
  });
  app.get("/api/ext/config", async () => view());
  app.post("/api/ext/config", async (req) => {
    const body = (req.body ?? {}) as { regen?: boolean; sitePassword?: string; webhookUrl?: string; sendLimit?: number };
    if (body.regen) regenExtAdminToken();
    if (typeof body.sitePassword === "string") setExtSitePassword(body.sitePassword);
    if (typeof body.webhookUrl === "string") setExtWebhookUrl(body.webhookUrl);
    if (typeof body.sendLimit === "number") setExtSendLimit(body.sendLimit);
    return view();
  });
}
