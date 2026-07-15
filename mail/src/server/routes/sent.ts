import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  formatSdkError,
  listRemoteSentMessages,
  readRemoteSentMail,
  type SentMailSummary
} from "../claw-mail";
import { getMailboxByEmail, listActiveMailboxes } from "../db";
import { listProviders, getProvider } from "../temp-providers";
import { cfListAliases, cfSent, cfMessage } from "../cf-mail";

/**
 * Sent-mailbox (发件箱) read-only routes — 统一聚合 claw 子邮箱 + 临时邮箱(php) 的已发。
 *
 * - claw：实时读 Claw "Sent" 文件夹（saveSentCopy 存的副本）。
 * - 临时(php)：external_sent 按别名取已发；cf 壳无已发概念，跳过。
 * 全程只读、不落本地库。
 *
 * - GET /api/sent              -> 所有邮箱(claw+临时)已发，合并按时间倒序
 * - GET /api/sent?mailbox=foo  -> 单个邮箱/别名已发
 * - GET /api/sent/:mailbox/:id -> 单封详情（按域名分流 claw / 临时）
 */

const listQuerySchema = z.object({
  mailbox: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const ALIAS_CAP = 25; // 统一视图下每个临时源最多扫这么多别名的已发，避免请求爆炸

type SentListItem = SentMailSummary & { mailbox_email: string };

function sortByDateDesc(a: SentListItem, b: SentListItem): number {
  const ta = a.date ? Date.parse(a.date) : 0;
  const tb = b.date ? Date.parse(b.date) : 0;
  return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
}

const domainOf = (addr: string) => (addr.split("@")[1] ?? "").trim().toLowerCase();

export async function sentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/sent", async (request, reply) => {
    const query = listQuerySchema.parse(request.query);
    const requested = query.mailbox?.trim().toLowerCase();

    const items: SentListItem[] = [];
    const errors: Array<{ mailbox: string; error: string }> = [];

    // ---- claw 子邮箱 ----
    const clawMailbox = requested ? getMailboxByEmail(requested) : null;
    const clawTargets = requested
      ? (clawMailbox ? [clawMailbox.email] : [])
      : listActiveMailboxes().map((m) => m.email);
    for (const email of clawTargets) {
      try {
        const messages = await listRemoteSentMessages(email, query.limit);
        for (const m of messages) items.push({ ...m, mailbox_email: email });
      } catch (err) {
        errors.push({ mailbox: email, error: formatSdkError(err) });
      }
    }

    // ---- 临时邮箱(php) ----
    const phpProviders = listProviders().filter((p) => p.type === "php");
    let matchedTemp = false;
    for (const provider of phpProviders) {
      const pdom = provider.domain.trim().toLowerCase();
      if (requested && domainOf(requested) !== pdom) continue;
      matchedTemp = matchedTemp || Boolean(requested);
      try {
        const aliases = requested
          ? [requested]
          : (await cfListAliases(provider)).map((a) => a.address).slice(0, ALIAS_CAP);
        for (const alias of aliases) {
          try {
            const sent = await cfSent(provider, alias);
            for (const m of sent) {
              items.push({
                id: String(m.uid),
                mailbox_email: alias,
                from: m.from ?? null,
                subject: m.subject ?? null,
                date: m.date ?? null,
                size: null
              });
            }
          } catch { /* 单别名失败跳过 */ }
        }
      } catch (err) {
        errors.push({ mailbox: provider.name, error: formatSdkError(err) });
      }
    }

    if (requested && clawTargets.length === 0 && !matchedTemp) {
      return reply.code(404).send({ error: "mailbox not found" });
    }

    items.sort(sortByDateDesc);
    const sliced = items.slice(0, query.limit); // 跨邮箱合并后取最新 N 封
    return { items: sliced, count: sliced.length, total: items.length, errors };
  });

  app.get("/api/sent/:mailbox/:id", async (request, reply) => {
    const { mailbox, id } = request.params as { mailbox: string; id: string };
    const normalized = mailbox.trim().toLowerCase();

    // claw：读 Sent 文件夹详情
    if (getMailboxByEmail(normalized)) {
      try {
        const detail = await readRemoteSentMail(normalized, id);
        return { ...detail, mailbox_email: normalized };
      } catch (err) {
        return reply.code(502).send({ error: formatSdkError(err) });
      }
    }

    // 临时(php)：按域名找源，external_message 读单封
    const provider = listProviders().find((p) => p.type === "php" && p.domain.trim().toLowerCase() === domainOf(normalized));
    if (!provider || !getProvider(provider.id)) {
      return reply.code(404).send({ error: "mailbox not found" });
    }
    try {
      const d = await cfMessage(provider, normalized, Number(id));
      return {
        id: String(d.uid),
        mailbox_email: normalized,
        from: d.from ? [d.from] : [],
        to: d.to ? [d.to] : [],
        cc: [],
        bcc: [],
        subject: d.subject ?? null,
        date: d.date ?? null,
        text: d.bodyText ?? d.preview ?? null,
        html: d.bodyHtml ?? null,
        hasAttachments: false,
        attachments: []
      };
    } catch (err) {
      return reply.code(502).send({ error: formatSdkError(err) });
    }
  });
}
