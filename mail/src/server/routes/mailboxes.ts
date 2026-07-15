import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createMailbox,
  deleteMailbox,
  listDashboardMailboxes,
  updateMailboxCommunicationSettings
} from "../claw-dashboard";
import {
  getMailboxById,
  listMailboxes,
  markMailboxDeleted,
  markMailboxesMissingDeleted,
  updateMailboxCommSettings,
  upsertMailbox
} from "../db";
import { startMailboxListener, stopMailboxListener } from "../listener-manager";
import { getParentMailboxId } from "../runtime-config";

const createMailboxSchema = z.object({
  suffix: z.string().regex(/^[a-z0-9]{1,32}$/)
});

const DEFAULT_COMM_SETTINGS = {
  commLevel: 2,
  extReceiveType: 1,
  extSendType: 1
} as const;

const commSettingsSchema = z.object({
  commLevel: z.number().int().min(0).max(2),
  extReceiveType: z.number().int().min(0).max(1).optional(),
  extSendType: z.number().int().min(0).max(1).optional()
}).superRefine((value, ctx) => {
  if (value.commLevel !== 2) return;
  if (value.extReceiveType === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["extReceiveType"],
      message: "extReceiveType is required when commLevel is 2"
    });
  }
  if (value.extSendType === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["extSendType"],
      message: "extSendType is required when commLevel is 2"
    });
  }
});

function upsertRemoteMailbox(item: {
  id: string;
  email: string;
  prefix: string;
  displayName?: string | null;
  status?: string | null;
  openclawStatus?: string | null;
  installCommand?: string | null;
  authUrl?: string | null;
  commLevel?: number | null;
  extReceiveType?: number | null;
  extSendType?: number | null;
}) {
  return upsertMailbox({
    id: item.id,
    email: item.email,
    prefix: item.prefix,
    displayName: item.displayName,
    status: item.status ?? "active",
    openclawStatus: item.openclawStatus,
    installCommand: item.installCommand,
    authUrl: item.authUrl,
    commLevel: item.commLevel,
    extReceiveType: item.extReceiveType,
    extSendType: item.extSendType
  });
}

export async function mailboxRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/mailboxes", async (request) => {
    const query = request.query as { sync?: string };
    if (query.sync === "true") {
      const remote = await listDashboardMailboxes();
      for (const item of remote) {
        const row = upsertRemoteMailbox(item);
        startMailboxListener(row);
      }
      for (const mailbox of markMailboxesMissingDeleted(remote.map((item) => item.email))) {
        stopMailboxListener(mailbox.email);
      }
    }
    return { items: listMailboxes(false) };
  });

  app.post("/api/mailboxes", async (request, reply) => {
    const body = createMailboxSchema.parse(request.body);
    const mailbox = await createMailbox(body.suffix);
    await updateMailboxCommunicationSettings(mailbox.id, DEFAULT_COMM_SETTINGS);
    const row = upsertRemoteMailbox({
      ...mailbox,
      commLevel: DEFAULT_COMM_SETTINGS.commLevel,
      extReceiveType: DEFAULT_COMM_SETTINGS.extReceiveType,
      extSendType: DEFAULT_COMM_SETTINGS.extSendType
    });
    startMailboxListener(row);
    return reply.code(201).send(row);
  });

  app.post("/api/mailboxes/:id/comm-settings", async (request, reply) => {
    const { id } = request.params as { id: string };
    const mailbox = getMailboxById(id);
    if (!mailbox) {
      return reply.code(404).send({ error: "mailbox not found" });
    }

    const body = commSettingsSchema.parse(request.body);
    const dashboardPayload = body.commLevel === 2
      ? {
          commLevel: body.commLevel,
          extReceiveType: body.extReceiveType!,
          extSendType: body.extSendType!
        }
      : { commLevel: body.commLevel };

    await updateMailboxCommunicationSettings(id, dashboardPayload);
    const updated = updateMailboxCommSettings(id, {
      commLevel: body.commLevel,
      extReceiveType: body.commLevel === 2 ? body.extReceiveType : null,
      extSendType: body.commLevel === 2 ? body.extSendType : null
    });
    return updated ?? getMailboxById(id);
  });

  app.delete("/api/mailboxes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const mailbox = getMailboxById(id);
    if (!mailbox) {
      return { success: true };
    }
    if (id === getParentMailboxId()) {
      return reply.code(400).send({ error: "primary mailbox cannot be deleted here" });
    }
    await deleteMailbox(id);
    markMailboxDeleted(id);
    stopMailboxListener(mailbox.email);
    return { success: true };
  });
}
