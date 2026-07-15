import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getMailboxByEmail, getMailById } from "../db";
import { replyMail, sendMail } from "../claw-mail";

const sendSchema = z.object({
  from: z.string().email(),
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  html: z.boolean().optional()
});

const replySchema = z.object({
  mailId: z.coerce.number().int().positive(),
  body: z.string().optional(),
  html: z.boolean().optional(),
  toAll: z.boolean().optional()
});

export async function sendRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/send", async (request, reply) => {
    const body = sendSchema.parse(request.body);
    const mailbox = getMailboxByEmail(body.from.trim().toLowerCase());
    if (!mailbox) {
      return reply.code(400).send({ error: "from mailbox is not managed by this app" });
    }
    const result = await sendMail(body);
    return result;
  });

  app.post("/api/reply", async (request, reply) => {
    const body = replySchema.parse(request.body);
    const mail = getMailById(body.mailId);
    if (!mail) {
      return reply.code(404).send({ error: "mail not found" });
    }
    const result = await replyMail({
      mailboxEmail: mail.mailbox_email,
      providerMailId: mail.provider_mail_id,
      body: body.body,
      html: body.html,
      toAll: body.toAll
    });
    return result;
  });
}
