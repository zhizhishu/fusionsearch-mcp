import { db } from "./db";
import { pullAll, resumeSync, suspendSync, supabaseConfigured } from "./supabase-sync";

function nz<T>(v: T | undefined | null): T | null {
  return v == null ? null : v;
}

function normalizeSetting(s: Record<string, unknown>) {
  return { key: s.key, value: s.value, updated_at: nz(s.updated_at as string | null) };
}

function normalizeMailbox(m: Record<string, unknown>) {
  return {
    id: m.id,
    email: m.email,
    prefix: nz(m.prefix as string | null),
    display_name: nz(m.display_name as string | null),
    account_id: nz(m.account_id as string | null),
    status: (nz(m.status as string | null) ?? "active"),
    openclaw_status: nz(m.openclaw_status as string | null),
    install_command: nz(m.install_command as string | null),
    auth_url: nz(m.auth_url as string | null),
    comm_level: nz(m.comm_level as number | null),
    ext_receive_type: nz(m.ext_receive_type as number | null),
    ext_send_type: nz(m.ext_send_type as number | null),
    created_at: nz(m.created_at as string | null),
    updated_at: nz(m.updated_at as string | null)
  };
}

function normalizeMail(m: Record<string, unknown>) {
  return {
    id: m.id,
    provider_mail_id: m.provider_mail_id,
    mailbox_email: m.mailbox_email,
    source: nz(m.source as string | null),
    address: nz(m.address as string | null),
    subject: nz(m.subject as string | null),
    text: nz(m.text as string | null),
    html: nz(m.html as string | null),
    raw_json: (m.raw_json as string) ?? "{}",
    header_raw: nz(m.header_raw as string | null),
    has_attachments: (m.has_attachments as number) ?? 0,
    received_at: nz(m.received_at as string | null),
    created_at: nz(m.created_at as string | null)
  };
}

function normalizeAttachment(a: Record<string, unknown>) {
  return {
    id: a.id,
    mail_id: a.mail_id,
    provider_part_id: (a.provider_part_id as string) ?? "",
    filename: nz(a.filename as string | null),
    content_type: nz(a.content_type as string | null),
    size: nz(a.size as number | null),
    created_at: nz(a.created_at as string | null)
  };
}

// 启动时从 Supabase 拉回全部数据灌入本地 SQLite（保留主键 id；期间挂起推送防回环）。
export async function hydrateFromSupabase(): Promise<void> {
  if (!supabaseConfigured()) return;

  let snapshot;
  try {
    snapshot = await pullAll();
  } catch (e) {
    console.error(`[supabase] hydrate pull failed: ${(e as Error).message}`);
    return;
  }
  if (!snapshot) return;

  suspendSync();
  try {
    const apply = db.transaction(() => {
      const insSetting = db.prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (@key, @value, COALESCE(@updated_at, CURRENT_TIMESTAMP))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      );
      for (const s of snapshot.settings) insSetting.run(normalizeSetting(s as Record<string, unknown>));

      const insMailbox = db.prepare(
        `INSERT INTO mailboxes
           (id, email, prefix, display_name, account_id, status, openclaw_status, install_command, auth_url, comm_level, ext_receive_type, ext_send_type, created_at, updated_at)
         VALUES
           (@id, @email, @prefix, @display_name, @account_id, @status, @openclaw_status, @install_command, @auth_url, @comm_level, @ext_receive_type, @ext_send_type, COALESCE(@created_at, CURRENT_TIMESTAMP), COALESCE(@updated_at, CURRENT_TIMESTAMP))
         ON CONFLICT(id) DO UPDATE SET
           email = excluded.email, prefix = excluded.prefix, display_name = excluded.display_name,
           account_id = excluded.account_id, status = excluded.status, openclaw_status = excluded.openclaw_status,
           install_command = excluded.install_command, auth_url = excluded.auth_url, comm_level = excluded.comm_level,
           ext_receive_type = excluded.ext_receive_type, ext_send_type = excluded.ext_send_type, updated_at = excluded.updated_at`
      );
      for (const m of snapshot.mailboxes) insMailbox.run(normalizeMailbox(m as unknown as Record<string, unknown>));

      const insMail = db.prepare(
        `INSERT OR IGNORE INTO mails
           (id, provider_mail_id, mailbox_email, source, address, subject, text, html, raw_json, header_raw, has_attachments, received_at, created_at)
         VALUES
           (@id, @provider_mail_id, @mailbox_email, @source, @address, @subject, @text, @html, @raw_json, @header_raw, @has_attachments, @received_at, COALESCE(@created_at, CURRENT_TIMESTAMP))`
      );
      for (const ml of snapshot.mails) insMail.run(normalizeMail(ml as unknown as Record<string, unknown>));

      const insAttachment = db.prepare(
        `INSERT OR IGNORE INTO attachments
           (id, mail_id, provider_part_id, filename, content_type, size, created_at)
         VALUES
           (@id, @mail_id, @provider_part_id, @filename, @content_type, @size, COALESCE(@created_at, CURRENT_TIMESTAMP))`
      );
      for (const a of snapshot.attachments) insAttachment.run(normalizeAttachment(a as unknown as Record<string, unknown>));
    });
    apply();
    console.log(
      `[supabase] hydrated ${snapshot.settings.length} settings, ${snapshot.mailboxes.length} mailboxes, ${snapshot.mails.length} mails, ${snapshot.attachments.length} attachments`
    );
  } catch (e) {
    console.error(`[supabase] hydrate apply failed: ${(e as Error).message}`);
  } finally {
    resumeSync();
  }
}
