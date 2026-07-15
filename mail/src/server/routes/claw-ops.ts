// /api/claw/* —— 把 claw-ops 能力层开放给前端面板（及后续的模型/脚本接口）。
// 这些都是「按需直连 claw」的操作（文件夹/浏览/搜索/已读/移动/转发/读信），
// 与 /api/mails（本地落库镜像）互补：面板可在不全量同步的前提下翻任意文件夹。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  forwardMail,
  getMessageSummaries,
  listFolders,
  listFolderMessages,
  markMessages,
  moveMessages,
  readRemoteMailDetail,
  searchMessages
} from "../claw-ops";
import { formatSdkError } from "../claw-mail";
import { hasClawMailConfig } from "../runtime-config";

const mailboxQuery = z.object({ mailbox: z.string().min(1) });

const listQuery = z.object({
  mailbox: z.string().min(1),
  fid: z.string().default("INBOX"),
  start: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  order: z.string().default("date"),
  desc: z.enum(["true", "false"]).default("true"),
  unread: z.enum(["true", "false"]).optional(),
  withSummaries: z.enum(["true", "false"]).default("true")
});

const searchQuery = z.object({
  mailbox: z.string().min(1),
  fid: z.string().default("INBOX"),
  q: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  since: z.string().optional(),
  before: z.string().optional(),
  unread: z.enum(["true", "false"]).optional(),
  fts: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const readQuery = z.object({
  mailbox: z.string().min(1),
  id: z.string().min(1),
  markRead: z.enum(["true", "false"]).default("false")
});

const markBody = z.object({
  mailbox: z.string().min(1),
  ids: z.array(z.string().min(1)).min(1),
  read: z.boolean()
});

const moveBody = z.object({
  mailbox: z.string().min(1),
  ids: z.array(z.string().min(1)).min(1),
  target: z.union([z.string().min(1), z.number()])
});

const forwardBody = z.object({
  mailbox: z.string().min(1),
  id: z.string().min(1),
  to: z.array(z.string().min(1)).min(1),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  body: z.string().optional(),
  html: z.boolean().optional(),
  mode: z.enum(["quote", "attach", "transmit"]).optional()
});

function lc(email: string): string {
  return email.trim().toLowerCase();
}

export async function clawOpsRoutes(app: FastifyInstance): Promise<void> {
  // 没配 claw key 时统一 409，前端好提示「先连接 Claw」。
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/claw/")) return;
    if (!hasClawMailConfig()) {
      return reply.code(409).send({ error: "Claw 未连接：请先在面板连接 Claw（缺少 API Key）" });
    }
  });

  const fail = (reply: any, error: unknown) =>
    reply.code(502).send({ error: formatSdkError(error) });

  app.get("/api/claw/folders", async (request, reply) => {
    const { mailbox } = mailboxQuery.parse(request.query);
    try {
      return { items: await listFolders(lc(mailbox)) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  // 按需浏览某文件夹（不落库）。withSummaries=true 时补全 from/subject。
  app.get("/api/claw/messages", async (request, reply) => {
    const query = listQuery.parse(request.query);
    const mailbox = lc(query.mailbox);
    try {
      const summaries = await listFolderMessages(mailbox, {
        fid: query.fid,
        start: query.start,
        limit: query.limit,
        order: query.order,
        desc: query.desc === "true",
        unread: query.unread === undefined ? undefined : query.unread === "true"
      });
      if (query.withSummaries !== "true" || summaries.length === 0) {
        return { items: summaries };
      }
      // listMessages 只给 id+flags；补一发 getMessageInfos 拿 from/subject/date。
      const infos = await getMessageSummaries(mailbox, summaries.map((m) => m.id));
      const infoById = new Map(infos.map((info) => [info.id, info]));
      const items = summaries.map((m) => ({ ...infoById.get(m.id), ...m }));
      return { items };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/api/claw/search", async (request, reply) => {
    const query = searchQuery.parse(request.query);
    try {
      const items = await searchMessages(lc(query.mailbox), {
        fid: query.fid,
        keyword: query.q,
        from: query.from,
        to: query.to,
        subject: query.subject,
        since: query.since,
        before: query.before,
        unread: query.unread === undefined ? undefined : query.unread === "true",
        fts: query.fts === undefined ? undefined : query.fts === "true",
        limit: query.limit
      });
      return { items };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/api/claw/message", async (request, reply) => {
    const query = readQuery.parse(request.query);
    try {
      const detail = await readRemoteMailDetail(lc(query.mailbox), query.id, query.markRead === "true");
      return { mail: detail };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/api/claw/mark", async (request, reply) => {
    const body = markBody.parse(request.body);
    try {
      await markMessages(lc(body.mailbox), body.ids, body.read);
      return { success: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/api/claw/move", async (request, reply) => {
    const body = moveBody.parse(request.body);
    try {
      await moveMessages(lc(body.mailbox), body.ids, body.target);
      return { success: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/api/claw/forward", async (request, reply) => {
    const body = forwardBody.parse(request.body);
    try {
      const result = await forwardMail(lc(body.mailbox), {
        id: body.id,
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        body: body.body,
        html: body.html,
        mode: body.mode
      });
      return result;
    } catch (error) {
      return fail(reply, error);
    }
  });
}
