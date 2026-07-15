import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";
import {
  deleteRemoteMail,
  deleteRemoteMailsByProvider,
  deleteRemoteSettings,
  pushMail,
  pushMailbox,
  pushSetting,
  replaceRemoteAttachments
} from "./supabase-sync";

mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });

export const db = new Database(config.DATABASE_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  display_name TEXT,
  account_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  openclaw_status TEXT,
  install_command TEXT,
  auth_url TEXT,
  comm_level INTEGER,
  ext_receive_type INTEGER,
  ext_send_type INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mailboxes_email ON mailboxes(email);
CREATE INDEX IF NOT EXISTS idx_mailboxes_status ON mailboxes(status);

CREATE TABLE IF NOT EXISTS mails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_mail_id TEXT NOT NULL,
  mailbox_email TEXT NOT NULL,
  source TEXT,
  address TEXT,
  subject TEXT,
  text TEXT,
  html TEXT,
  raw_json TEXT NOT NULL,
  header_raw TEXT,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  received_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(mailbox_email, provider_mail_id)
);

CREATE INDEX IF NOT EXISTS idx_mails_mailbox_email ON mails(mailbox_email);
CREATE INDEX IF NOT EXISTS idx_mails_created_at ON mails(created_at);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mail_id INTEGER NOT NULL,
  provider_part_id TEXT NOT NULL,
  filename TEXT,
  content_type TEXT,
  size INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(mail_id) REFERENCES mails(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attachments_mail_id ON attachments(mail_id);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function ensureColumn(table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

ensureColumn("mailboxes", "comm_level", "INTEGER");
ensureColumn("mailboxes", "ext_receive_type", "INTEGER");
ensureColumn("mailboxes", "ext_send_type", "INTEGER");

export type MailboxRow = {
  id: string;
  email: string;
  prefix: string;
  display_name: string | null;
  account_id: string | null;
  status: string;
  openclaw_status: string | null;
  install_command: string | null;
  auth_url: string | null;
  comm_level: number | null;
  ext_receive_type: number | null;
  ext_send_type: number | null;
  created_at: string;
  updated_at: string;
};

export type MailRow = {
  id: number;
  provider_mail_id: string;
  mailbox_email: string;
  source: string | null;
  address: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  raw_json: string;
  header_raw: string | null;
  has_attachments: number;
  received_at: string | null;
  created_at: string;
};

export type AttachmentRow = {
  id: number;
  mail_id: number;
  provider_part_id: string;
  filename: string | null;
  content_type: string | null;
  size: number | null;
  created_at: string;
};

export function upsertMailbox(input: {
  id: string;
  email: string;
  prefix: string;
  displayName?: string | null;
  accountId?: string | null;
  status?: string | null;
  openclawStatus?: string | null;
  installCommand?: string | null;
  authUrl?: string | null;
  commLevel?: number | null;
  extReceiveType?: number | null;
  extSendType?: number | null;
}): MailboxRow {
  db.prepare(`
    INSERT INTO mailboxes
      (
        id, email, prefix, display_name, account_id, status, openclaw_status,
        install_command, auth_url, comm_level, ext_receive_type, ext_send_type
      )
    VALUES
      (
        @id, @email, @prefix, @displayName, @accountId, @status, @openclawStatus,
        @installCommand, @authUrl, @commLevel, @extReceiveType, @extSendType
      )
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      prefix = excluded.prefix,
      display_name = excluded.display_name,
      account_id = excluded.account_id,
      status = excluded.status,
      openclaw_status = excluded.openclaw_status,
      install_command = excluded.install_command,
      auth_url = excluded.auth_url,
      comm_level = excluded.comm_level,
      ext_receive_type = excluded.ext_receive_type,
      ext_send_type = excluded.ext_send_type,
      updated_at = CURRENT_TIMESTAMP
    ON CONFLICT(email) DO UPDATE SET
      id = excluded.id,
      prefix = excluded.prefix,
      display_name = excluded.display_name,
      account_id = excluded.account_id,
      status = excluded.status,
      openclaw_status = excluded.openclaw_status,
      install_command = excluded.install_command,
      auth_url = excluded.auth_url,
      comm_level = excluded.comm_level,
      ext_receive_type = excluded.ext_receive_type,
      ext_send_type = excluded.ext_send_type,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    ...input,
    status: input.status ?? "active",
    displayName: input.displayName ?? null,
    accountId: input.accountId ?? null,
    openclawStatus: input.openclawStatus ?? null,
    installCommand: input.installCommand ?? null,
    authUrl: input.authUrl ?? null,
    commLevel: input.commLevel ?? null,
    extReceiveType: input.extReceiveType ?? null,
    extSendType: input.extSendType ?? null
  });
  const saved = getMailboxById(input.id)!;
  pushMailbox(saved);
  return saved;
}

export function listMailboxes(includeDeleted = false): MailboxRow[] {
  const sql = includeDeleted
    ? "SELECT * FROM mailboxes ORDER BY created_at DESC, email ASC"
    : "SELECT * FROM mailboxes WHERE status != 'deleted' ORDER BY created_at DESC, email ASC";
  return db.prepare(sql).all() as MailboxRow[];
}

export function listActiveMailboxes(): MailboxRow[] {
  return db.prepare("SELECT * FROM mailboxes WHERE status = 'active' ORDER BY email ASC").all() as MailboxRow[];
}

export function getMailboxById(id: string): MailboxRow | undefined {
  return db.prepare("SELECT * FROM mailboxes WHERE id = ?").get(id) as MailboxRow | undefined;
}

export function getMailboxByEmail(email: string): MailboxRow | undefined {
  return db.prepare("SELECT * FROM mailboxes WHERE email = ? AND status != 'deleted'").get(email) as MailboxRow | undefined;
}

export function markMailboxDeleted(id: string): void {
  db.prepare("UPDATE mailboxes SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  const deleted = getMailboxById(id);
  if (deleted) pushMailbox(deleted);
}

export function updateMailboxCommSettings(id: string, input: {
  commLevel: number;
  extReceiveType?: number | null;
  extSendType?: number | null;
}): MailboxRow | undefined {
  db.prepare(`
    UPDATE mailboxes
    SET
      comm_level = @commLevel,
      ext_receive_type = @extReceiveType,
      ext_send_type = @extSendType,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    id,
    commLevel: input.commLevel,
    extReceiveType: input.extReceiveType ?? null,
    extSendType: input.extSendType ?? null
  });
  const updated = getMailboxById(id);
  if (updated) pushMailbox(updated);
  return updated;
}

export function markMailboxesMissingDeleted(remoteEmails: string[]): MailboxRow[] {
  const remoteEmailSet = new Set(remoteEmails.map((email) => email.trim().toLowerCase()));
  const missing = listActiveMailboxes().filter((mailbox) => !remoteEmailSet.has(mailbox.email.toLowerCase()));
  const transaction = db.transaction(() => {
    const statement = db.prepare("UPDATE mailboxes SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    for (const mailbox of missing) {
      statement.run(mailbox.id);
    }
  });
  transaction();
  for (const mailbox of missing) {
    const row = getMailboxById(mailbox.id);
    if (row) pushMailbox(row);
  }
  return missing;
}

export function saveMail(input: {
  providerMailId: string;
  mailboxEmail: string;
  source?: string | null;
  address?: string | null;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  rawJson: string;
  headerRaw?: string | null;
  hasAttachments?: boolean;
  receivedAt?: string | null;
  attachments?: Array<{
    providerPartId: string;
    filename?: string | null;
    contentType?: string | null;
    size?: number | null;
  }>;
}): MailRow {
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO mails
        (provider_mail_id, mailbox_email, source, address, subject, text, html, raw_json, header_raw, has_attachments, received_at)
      VALUES
        (@providerMailId, @mailboxEmail, @source, @address, @subject, @text, @html, @rawJson, @headerRaw, @hasAttachments, @receivedAt)
      ON CONFLICT(mailbox_email, provider_mail_id) DO UPDATE SET
        source = excluded.source,
        address = excluded.address,
        subject = excluded.subject,
        text = excluded.text,
        html = excluded.html,
        raw_json = excluded.raw_json,
        header_raw = excluded.header_raw,
        has_attachments = excluded.has_attachments,
        received_at = excluded.received_at
    `).run({
      ...input,
      source: input.source ?? null,
      address: input.address ?? null,
      subject: input.subject ?? null,
      text: input.text ?? null,
      html: input.html ?? null,
      headerRaw: input.headerRaw ?? null,
      hasAttachments: input.hasAttachments ? 1 : 0,
      receivedAt: input.receivedAt ?? null
    });

    const row = db.prepare(`
      SELECT * FROM mails WHERE mailbox_email = ? AND provider_mail_id = ?
    `).get(input.mailboxEmail, input.providerMailId) as MailRow;

    db.prepare("DELETE FROM attachments WHERE mail_id = ?").run(row.id);
    const insertAttachment = db.prepare(`
      INSERT INTO attachments (mail_id, provider_part_id, filename, content_type, size)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const attachment of input.attachments ?? []) {
      insertAttachment.run(
        row.id,
        attachment.providerPartId,
        attachment.filename ?? null,
        attachment.contentType ?? null,
        attachment.size ?? null
      );
    }

    return row;
  });

  const saved = transaction();
  pushMail(saved);
  replaceRemoteAttachments(saved.id, listAttachments(saved.id));
  return saved;
}

export function listMails(input: {
  mailboxEmail?: string;
  limit: number;
  offset: number;
}): { items: MailRow[]; count: number } {
  const where = input.mailboxEmail ? "WHERE mailbox_email = ?" : "";
  const params = input.mailboxEmail ? [input.mailboxEmail] : [];
  const items = db.prepare(`
    SELECT * FROM mails ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, input.limit, input.offset) as MailRow[];
  const count = db.prepare(`SELECT COUNT(*) AS count FROM mails ${where}`).get(...params) as { count: number };
  return { items, count: count.count };
}

export function listMailProviderIds(mailboxEmail: string): string[] {
  const rows = db.prepare("SELECT provider_mail_id FROM mails WHERE mailbox_email = ?")
    .all(mailboxEmail) as Array<{ provider_mail_id: string }>;
  return rows.map((row) => row.provider_mail_id);
}

export function getMailById(id: number): MailRow | undefined {
  return db.prepare("SELECT * FROM mails WHERE id = ?").get(id) as MailRow | undefined;
}

export function getMailByProviderId(mailboxEmail: string, providerMailId: string): MailRow | undefined {
  return db.prepare("SELECT * FROM mails WHERE mailbox_email = ? AND provider_mail_id = ?")
    .get(mailboxEmail, providerMailId) as MailRow | undefined;
}

export function deleteMailById(id: number): boolean {
  const result = db.prepare("DELETE FROM mails WHERE id = ?").run(id);
  if (result.changes > 0) deleteRemoteMail(id);
  return result.changes > 0;
}

export function deleteMailsByProviderIds(mailboxEmail: string, providerMailIds: string[]): number {
  if (providerMailIds.length === 0) return 0;
  const transaction = db.transaction(() => {
    const statement = db.prepare("DELETE FROM mails WHERE mailbox_email = ? AND provider_mail_id = ?");
    let count = 0;
    for (const providerMailId of providerMailIds) {
      count += statement.run(mailboxEmail, providerMailId).changes;
    }
    return count;
  });
  const removed = transaction();
  deleteRemoteMailsByProvider(mailboxEmail, providerMailIds);
  return removed;
}

export function listAttachments(mailId: number): AttachmentRow[] {
  return db.prepare("SELECT * FROM attachments WHERE mail_id = ? ORDER BY id ASC").all(mailId) as AttachmentRow[];
}

export function getSetting(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
  pushSetting(key, value);
}

export function deleteSettings(keys: string[]): void {
  const transaction = db.transaction(() => {
    const statement = db.prepare("DELETE FROM app_settings WHERE key = ?");
    for (const key of keys) {
      statement.run(key);
    }
  });
  transaction();
  deleteRemoteSettings(keys);
}
