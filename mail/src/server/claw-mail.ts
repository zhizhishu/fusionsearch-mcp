import { MailClient, MailSdkError, type MailDetail } from "@clawemail/node-sdk";
import { requireClawApiKey } from "./runtime-config";

export type SendMailInput = {
  from: string;
  to: string[];
  subject?: string;
  body?: string;
  html?: boolean;
  cc?: string[];
  bcc?: string[];
};

export type ReplyMailInput = {
  mailboxEmail: string;
  providerMailId: string;
  body?: string;
  html?: boolean;
  toAll?: boolean;
};

type RemoteMessageSummary = {
  id: string;
  from?: string;
  subject?: string;
  date?: string;
  size?: number;
  read?: boolean;
};

type RemoteReadMessageResult = {
  id: string;
  from?: string[];
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  date?: string;
  headerRaw?: string;
  text?: { content?: string };
  html?: { content?: string };
  attachments?: Array<{
    id: string;
    filename?: string;
    contentType?: string;
    contentLength?: number;
  }>;
};

type InternalMailTransport = {
  listMessages?: (input: {
    fid: string | number;
    start?: number;
    limit?: number;
    order?: string;
    desc?: boolean;
  }) => Promise<RemoteMessageSummary[]>;
  readMessage?: (input: {
    id: string;
    fid?: string | number;
    mode?: "html" | "text" | "both";
    markRead?: boolean;
  }) => Promise<RemoteReadMessageResult>;
  moveMessages?: (ids: string[], target: string | number) => Promise<unknown>;
};

// Claw/Coremail folder id alias for the "Sent" mailbox. The SDK transport maps
// the named alias to its numeric folder id internally (Sent -> 3).
const SENT_FOLDER_ID = "Sent";

export type SentMailSummary = {
  id: string;
  from: string | null;
  subject: string | null;
  date: string | null;
  size: number | null;
};

export type SentMailDetail = {
  id: string;
  from: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  date: string | null;
  text: string | null;
  html: string | null;
  hasAttachments: boolean;
  attachments: Array<{
    id: string;
    filename: string | null;
    contentType: string | null;
    size: number | null;
  }>;
};

const clients = new Map<string, MailClient>();

export function getMailClient(email: string): MailClient {
  const normalized = email.trim().toLowerCase();
  const existing = clients.get(normalized);
  if (existing) return existing;

  const client = new MailClient({
    apiKey: requireClawApiKey(),
    user: normalized,
    logger: null
  });
  clients.set(normalized, client);
  return client;
}

export function resetMailClients(): void {
  for (const client of clients.values()) {
    try {
      client.ws.disconnect();
    } catch {
      // ignore disconnect errors
    }
  }
  clients.clear();
}

export async function sendMail(input: SendMailInput): Promise<{ status: "sent" }> {
  if (!input.to.length) {
    throw new Error("to must not be empty");
  }
  const client = getMailClient(input.from);
  return await client.mail.send({
    to: input.to,
    subject: input.subject,
    body: input.body,
    html: input.html,
    cc: input.cc,
    bcc: input.bcc
  });
}

export async function replyMail(input: ReplyMailInput): Promise<{ status: "sent" }> {
  const client = getMailClient(input.mailboxEmail);
  return await client.mail.reply({
    id: input.providerMailId,
    body: input.body,
    html: input.html,
    toAll: input.toAll
  });
}

export async function deleteRemoteMail(mailboxEmail: string, providerMailId: string): Promise<void> {
  const client = getMailClient(mailboxEmail);
  const transport = getInternalTransport(client);

  if (!transport?.moveMessages) {
    throw new Error("Remote mail deletion is not supported by the installed Claw SDK");
  }

  await transport.moveMessages([providerMailId], "Trash");
}

export async function listRemoteInboxMessageIds(mailboxEmail: string, maxMessages = 500): Promise<string[]> {
  const client = getMailClient(mailboxEmail);
  const transport = getInternalTransport(client);
  if (!transport?.listMessages) {
    throw new Error("Remote mailbox sync is not supported by the installed Claw SDK");
  }

  const ids: string[] = [];
  const pageSize = 100;
  for (let start = 0; start < maxMessages; start += pageSize) {
    const messages = await transport.listMessages({
      fid: "INBOX",
      start,
      limit: Math.min(pageSize, maxMessages - start),
      order: "date",
      desc: true
    });
    for (const message of messages) {
      if (message.id) ids.push(message.id);
    }
    if (messages.length < pageSize) break;
  }
  return ids;
}

export async function readRemoteMail(mailboxEmail: string, providerMailId: string): Promise<MailDetail> {
  return await getMailClient(mailboxEmail).mail.read({
    id: providerMailId,
    markRead: false
  });
}

/**
 * List the most recent messages from a mailbox's Sent folder.
 *
 * The high-level `MailResource` only exposes inbox-style read/send/reply, so we
 * reach into the internal transport (same pattern as the inbox sync path) and
 * target the "Sent" folder alias. Returns lightweight summaries; bodies are
 * fetched lazily via `readRemoteSentMail`.
 */
export async function listRemoteSentMessages(
  mailboxEmail: string,
  maxMessages = 100
): Promise<SentMailSummary[]> {
  const client = getMailClient(mailboxEmail);
  const transport = getInternalTransport(client);
  if (!transport?.listMessages) {
    throw new Error("Remote sent-folder listing is not supported by the installed Claw SDK");
  }

  const summaries: SentMailSummary[] = [];
  const pageSize = 50;
  for (let start = 0; start < maxMessages; start += pageSize) {
    const messages = await transport.listMessages({
      fid: SENT_FOLDER_ID,
      start,
      limit: Math.min(pageSize, maxMessages - start),
      order: "date",
      desc: true
    });
    for (const message of messages) {
      if (!message.id) continue;
      summaries.push({
        id: message.id,
        from: message.from ?? null,
        subject: message.subject ?? null,
        date: message.date ?? null,
        size: message.size ?? null
      });
    }
    if (messages.length < pageSize) break;
  }
  return summaries;
}

/** Read a single message detail from the Sent folder. */
export async function readRemoteSentMail(
  mailboxEmail: string,
  providerMailId: string
): Promise<SentMailDetail> {
  const client = getMailClient(mailboxEmail);
  const transport = getInternalTransport(client);
  if (!transport?.readMessage) {
    throw new Error("Remote sent-folder read is not supported by the installed Claw SDK");
  }

  const mail = await transport.readMessage({
    id: providerMailId,
    fid: SENT_FOLDER_ID,
    mode: "both",
    markRead: false
  });

  const attachments = (mail.attachments ?? []).map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename ?? null,
    contentType: attachment.contentType ?? null,
    size: attachment.contentLength ?? null
  }));

  return {
    id: mail.id,
    from: mail.from ?? [],
    to: mail.to ?? [],
    cc: mail.cc ?? [],
    bcc: mail.bcc ?? [],
    subject: mail.subject ?? null,
    date: mail.date ?? null,
    text: mail.text?.content ?? null,
    html: mail.html?.content ?? null,
    hasAttachments: attachments.length > 0,
    attachments
  };
}

function getInternalTransport(client: MailClient): InternalMailTransport | undefined {
  return (client as unknown as { transport?: InternalMailTransport }).transport;
}

export function formatSdkError(error: unknown): string {
  if (error instanceof MailSdkError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
