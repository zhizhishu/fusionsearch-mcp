-- Supabase 持久化镜像表（对齐本地 SQLite 列名/类型；时间统一用 text 以零转换 upsert）
-- 由糯米酱接入：HF 易失存储 -> 数据沉淀到 Supabase。

create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_at text
);

create table if not exists mailboxes (
  id text primary key,
  email text not null,
  prefix text,
  display_name text,
  account_id text,
  status text,
  openclaw_status text,
  install_command text,
  auth_url text,
  comm_level integer,
  ext_receive_type integer,
  ext_send_type integer,
  created_at text,
  updated_at text
);

create table if not exists mails (
  id bigint primary key,
  provider_mail_id text not null,
  mailbox_email text not null,
  source text,
  address text,
  subject text,
  text text,
  html text,
  raw_json text,
  header_raw text,
  has_attachments integer default 0,
  received_at text,
  created_at text,
  unique (mailbox_email, provider_mail_id)
);

create index if not exists idx_mails_mailbox_email on mails (mailbox_email);

create table if not exists attachments (
  id bigint primary key,
  mail_id bigint not null,
  provider_part_id text,
  filename text,
  content_type text,
  size integer,
  created_at text
);

create index if not exists idx_attachments_mail_id on attachments (mail_id);

-- 启用 RLS 且不建任何 policy：anon/publishable key 一律被拒，
-- 仅 service/secret key（绕 RLS）可读写。凭据安全。
alter table app_settings enable row level security;
alter table mailboxes enable row level security;
alter table mails enable row level security;
alter table attachments enable row level security;
