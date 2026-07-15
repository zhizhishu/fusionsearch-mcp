import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getAuthMe,
  listApiKeys,
  listDashboardMailboxes,
  listWorkspaces,
  sendLoginCode,
  verifyLoginCode,
  type ClawMailbox
} from "../claw-dashboard";
import { resetMailClients } from "../claw-mail";
import { markMailboxesMissingDeleted, upsertMailbox } from "../db";
import { startAllMailboxListeners, stopAllMailboxListeners } from "../listener-manager";
import {
  clearClawAuthSettings,
  getClawAuthStatus,
  requireDashboardCookie,
  saveClawAuthSettings
} from "../runtime-config";

const sendCodeSchema = z.object({
  email: z.string().email()
});

const verifyCodeSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{4,8}$/)
});

function emailDomain(email: string): string {
  return email.split("@")[1] || "claw.163.com";
}

function mailboxRootPrefix(mailbox: ClawMailbox): string {
  if (mailbox.prefix) {
    return mailbox.prefix.split("@")[0].split(".")[0];
  }
  return mailbox.email.split("@")[0].split(".")[0];
}

function saveMailboxes(mailboxes: ClawMailbox[]): void {
  for (const item of mailboxes) {
    upsertMailbox({
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
  markMailboxesMissingDeleted(mailboxes.map((item) => item.email));
}

async function connectWithCookie(cookie: string) {
  const [user, workspaces, apiKeys] = await Promise.all([
    getAuthMe(cookie),
    listWorkspaces(cookie),
    listApiKeys(cookie)
  ]);

  const workspace = workspaces.find((item) => item.status === "active") ?? workspaces[0];
  if (!workspace) {
    throw new Error("Claw account has no active workspace");
  }

  const apiKey =
    apiKeys.find((item) => item.status === "active" && item.defaultFlag === 1) ??
    apiKeys.find((item) => item.status === "active") ??
    apiKeys[0];
  if (!apiKey?.apiKey) {
    throw new Error("Claw account has no API key to use");
  }

  const mailboxes = await listDashboardMailboxes({
    cookie,
    workspaceId: workspace.id
  });
  const primaryMailbox =
    mailboxes.find((item) => item.mailboxType === "primary") ??
    mailboxes.find((item) => !item.email.split("@")[0].includes(".")) ??
    mailboxes[0];
  if (!primaryMailbox) {
    throw new Error("Claw account has no mailbox");
  }

  const userEmail =
    typeof user?.email === "string" ? user.email :
    typeof user?.emailAddress === "string" ? user.emailAddress :
    null;

  stopAllMailboxListeners();
  resetMailClients();
  saveClawAuthSettings({
    apiKey: apiKey.apiKey,
    dashboardCookie: cookie,
    userEmail,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    parentMailboxId: primaryMailbox.id,
    rootPrefix: mailboxRootPrefix(primaryMailbox),
    domain: emailDomain(primaryMailbox.email)
  });
  saveMailboxes(mailboxes);
  startAllMailboxListeners();

  return {
    auth: getClawAuthStatus(),
    syncedMailboxes: mailboxes.length
  };
}

export async function clawAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/auth/claw/status", async () => {
    return getClawAuthStatus();
  });

  app.post("/api/auth/claw/send-code", async (request) => {
    const body = sendCodeSchema.parse(request.body);
    await sendLoginCode(body.email);
    return { success: true };
  });

  app.post("/api/auth/claw/verify-code", async (request) => {
    const body = verifyCodeSchema.parse(request.body);
    const cookie = await verifyLoginCode(body.email, body.code);
    return await connectWithCookie(cookie);
  });

  app.post("/api/auth/claw/refresh", async () => {
    return await connectWithCookie(requireDashboardCookie());
  });

  app.post("/api/auth/claw/logout", async () => {
    stopAllMailboxListeners();
    resetMailClients();
    clearClawAuthSettings();
    return getClawAuthStatus();
  });
}
