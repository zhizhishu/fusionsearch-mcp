import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config";
import type { AttachmentRow, MailRow, MailboxRow } from "./db";

let client: SupabaseClient | null = null;
let suspended = false;

export function supabaseConfigured(): boolean {
  return Boolean(config.SUPABASE_URL && config.SUPABASE_SERVICE_KEY);
}

function getClient(): SupabaseClient | null {
  if (!supabaseConfigured()) return null;
  if (!client) {
    client = createClient(config.SUPABASE_URL as string, config.SUPABASE_SERVICE_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return client;
}

// hydrate 期间挂起推送，避免把灌回本地的数据又推回云端。
export function suspendSync(): void {
  suspended = true;
}
export function resumeSync(): void {
  suspended = false;
}

type PostgrestLike = PromiseLike<{ error: { message?: string } | null }>;

function bg(promise: PostgrestLike, label: string): void {
  Promise.resolve(promise)
    .then((res) => {
      if (res?.error) console.error(`[supabase] ${label} failed: ${res.error.message ?? res.error}`);
    })
    .catch((e) => console.error(`[supabase] ${label} threw: ${(e && e.message) || e}`));
}

export function pushSetting(key: string, value: string): void {
  if (suspended) return;
  const c = getClient();
  if (!c) return;
  bg(
    c.from("app_settings").upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" }),
    `setting:${key}`
  );
}

export function deleteRemoteSettings(keys: string[]): void {
  if (suspended || keys.length === 0) return;
  const c = getClient();
  if (!c) return;
  bg(c.from("app_settings").delete().in("key", keys), "settings:delete");
}

export function pushMailbox(row: MailboxRow): void {
  if (suspended) return;
  const c = getClient();
  if (!c) return;
  bg(c.from("mailboxes").upsert(row, { onConflict: "id" }), `mailbox:${row.id}`);
}

export function pushMail(row: MailRow): void {
  if (suspended) return;
  const c = getClient();
  if (!c) return;
  bg(c.from("mails").upsert(row, { onConflict: "id" }), `mail:${row.id}`);
}

export function replaceRemoteAttachments(mailId: number, rows: AttachmentRow[]): void {
  if (suspended) return;
  const c = getClient();
  if (!c) return;
  Promise.resolve(c.from("attachments").delete().eq("mail_id", mailId))
    .then(() => (rows.length ? c.from("attachments").upsert(rows, { onConflict: "id" }) : null))
    .then((res) => {
      const error = (res as { error?: { message?: string } | null } | null)?.error;
      if (error) console.error(`[supabase] attachments:${mailId} failed: ${error.message ?? error}`);
    })
    .catch((e) => console.error(`[supabase] attachments:${mailId} threw: ${(e && e.message) || e}`));
}

export function deleteRemoteMail(id: number): void {
  if (suspended) return;
  const c = getClient();
  if (!c) return;
  bg(c.from("mails").delete().eq("id", id), `mail:delete:${id}`);
}

export function deleteRemoteMailsByProvider(mailboxEmail: string, providerMailIds: string[]): void {
  if (suspended || providerMailIds.length === 0) return;
  const c = getClient();
  if (!c) return;
  bg(
    c.from("mails").delete().eq("mailbox_email", mailboxEmail).in("provider_mail_id", providerMailIds),
    "mails:delete-provider"
  );
}

export type RemoteSnapshot = {
  settings: Array<{ key: string; value: string; updated_at: string | null }>;
  mailboxes: MailboxRow[];
  mails: MailRow[];
  attachments: AttachmentRow[];
};

export async function pullAll(): Promise<RemoteSnapshot | null> {
  const c = getClient();
  if (!c) return null;
  const [s, m, ml, a] = await Promise.all([
    c.from("app_settings").select("*"),
    c.from("mailboxes").select("*"),
    c.from("mails").select("*").order("id", { ascending: false }).limit(3000),
    c.from("attachments").select("*").limit(8000)
  ]);
  const firstError = s.error || m.error || ml.error || a.error;
  if (firstError) {
    console.error(`[supabase] pullAll failed: ${firstError.message}`);
    return null;
  }
  return {
    settings: (s.data as RemoteSnapshot["settings"]) ?? [],
    mailboxes: (m.data as MailboxRow[]) ?? [],
    mails: (ml.data as MailRow[]) ?? [],
    attachments: (a.data as AttachmentRow[]) ?? []
  };
}
