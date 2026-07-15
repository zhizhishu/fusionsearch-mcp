export type Mailbox = {
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

export type MailSummary = {
  id: number;
  provider_mail_id: string;
  mailbox_email: string;
  source: string | null;
  address: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  has_attachments: number;
  received_at: string | null;
  created_at: string;
};

export type MailDetail = MailSummary & {
  parsed: any;
  attachments: Array<{
    id: number;
    mail_id: number;
    provider_part_id: string;
    filename: string | null;
    content_type: string | null;
    size: number | null;
  }>;
};

export type ClawAuthStatus = {
  connected: boolean;
  hasApiKey: boolean;
  hasDashboardCookie: boolean;
  userEmail: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  parentMailboxId: string | null;
  rootPrefix: string | null;
  domain: string | null;
  apiKeyPrefix: string | null;
  apiKeySuffix: string | null;
};

export type ListenerSnapshot = {
  email: string;
  status: string;
  startedAt?: string | null;
  lastEventAt?: string | null;
  error?: string | null;
};

export type RuntimeMode = "node" | "cloudflare" | "unknown";

let runtimeMode: RuntimeMode = "unknown";

let adminPassword = localStorage.getItem("adminPassword") ?? "";

export function getAdminPassword() {
  return adminPassword;
}

export function setAdminPassword(value: string) {
  adminPassword = value;
  if (value) {
    localStorage.setItem("adminPassword", value);
  } else {
    localStorage.removeItem("adminPassword");
  }
}

// API base prefix for mounting under a sub-path (e.g. "/email" when co-located
// behind FusionSearch). Empty by default → standalone deploy is unaffected.
// Injected at build time via VITE_API_BASE; used by every API call, the SSE
// stream, and attachment links.
export const API_BASE = (import.meta as any).env?.VITE_API_BASE ?? "";
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  adminPasswordOverride = adminPassword
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("x-admin-password", adminPasswordOverride);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(API_BASE + path, {
    ...init,
    headers
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.error ?? `HTTP ${response.status}`);
  }
  return data as T;
}

export async function verifyAdminPassword(value: string): Promise<ClawAuthStatus> {
  return requestJson<ClawAuthStatus>("/api/auth/claw/status", {}, value);
}

export async function fetchMailboxes(sync = false): Promise<Mailbox[]> {
  const data = await requestJson<{ items: Mailbox[] }>(`/api/mailboxes${sync ? "?sync=true" : ""}`);
  return data.items;
}

export async function createMailbox(suffix: string): Promise<Mailbox> {
  return requestJson<Mailbox>("/api/mailboxes", {
    method: "POST",
    body: JSON.stringify({ suffix })
  });
}

export async function deleteMailbox(id: string): Promise<void> {
  await requestJson<{ success: boolean }>(`/api/mailboxes/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export type CommunicationSettingsInput = {
  commLevel: 0 | 1 | 2;
  extReceiveType?: 0 | 1;
  extSendType?: 0 | 1;
};

export async function updateMailboxCommunicationSettings(
  id: string,
  input: CommunicationSettingsInput
): Promise<Mailbox> {
  return requestJson<Mailbox>(`/api/mailboxes/${encodeURIComponent(id)}/comm-settings`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function fetchMails(
  mailbox?: string,
  limit = 50,
  offset = 0,
  sync = false
): Promise<{ items: MailSummary[]; count: number }> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (mailbox) params.set("mailbox", mailbox);
  if (sync) params.set("sync", "true");
  return requestJson(`/api/mails?${params.toString()}`);
}

export async function fetchMail(id: number): Promise<MailDetail> {
  return requestJson(`/api/mails/${id}`);
}

export async function deleteMail(id: number): Promise<void> {
  await requestJson<{ success: boolean }>(`/api/mails/${id}`, {
    method: "DELETE"
  });
}

// ---- 发件箱（只读，实时读 Claw「已发送」文件夹）----
export type SentMailSummary = {
  id: string; mailbox_email: string; from: string | null; subject: string | null; date: string | null; size: number | null;
};
export type SentMailDetail = {
  id: string; mailbox_email: string; from: string[]; to: string[]; cc: string[]; bcc: string[];
  subject: string | null; date: string | null; text: string | null; html: string | null;
  hasAttachments: boolean;
  attachments: Array<{ id: string; filename: string | null; contentType: string | null; size: number | null }>;
};
export async function fetchSentMails(
  mailbox?: string,
  limit = 50
): Promise<{ items: SentMailSummary[]; count: number; errors: Array<{ mailbox: string; error: string }> }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (mailbox) params.set("mailbox", mailbox);
  return requestJson(`/api/sent?${params.toString()}`);
}
export async function fetchSentMail(mailbox: string, id: string): Promise<SentMailDetail> {
  return requestJson(`/api/sent/${encodeURIComponent(mailbox)}/${encodeURIComponent(id)}`);
}

export type SendMailInput = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  html?: boolean;
};

export async function sendMail(input: SendMailInput) {
  return requestJson<{ status: "sent" }>("/api/send", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export type ReplyMailInput = {
  mailId: number;
  body?: string;
  html?: boolean;
  toAll?: boolean;
};

export async function replyMail(input: ReplyMailInput) {
  return requestJson<{ status: "sent" }>("/api/reply", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function createEventSource(): EventSource {
  return new EventSource(apiUrl(`/api/events?token=${encodeURIComponent(adminPassword)}`));
}

export function getRuntimeMode(): RuntimeMode {
  return runtimeMode;
}

export function setRuntimeMode(value: RuntimeMode) {
  runtimeMode = value;
}

export async function fetchClawAuthStatus(): Promise<ClawAuthStatus> {
  return requestJson<ClawAuthStatus>("/api/auth/claw/status");
}

export async function sendClawLoginCode(email: string): Promise<void> {
  await requestJson<{ success: boolean }>("/api/auth/claw/send-code", {
    method: "POST",
    body: JSON.stringify({ email })
  });
}

export async function verifyClawLoginCode(email: string, code: string): Promise<{
  auth: ClawAuthStatus;
  syncedMailboxes: number;
}> {
  return requestJson("/api/auth/claw/verify-code", {
    method: "POST",
    body: JSON.stringify({ email, code })
  });
}

export async function refreshClawConnection(): Promise<{
  auth: ClawAuthStatus;
  syncedMailboxes: number;
}> {
  return requestJson("/api/auth/claw/refresh", {
    method: "POST"
  });
}

export async function disconnectClaw(): Promise<ClawAuthStatus> {
  return requestJson("/api/auth/claw/logout", {
    method: "POST"
  });
}

export async function fetchListeners(): Promise<ListenerSnapshot[]> {
  const data = await requestJson<{ items: ListenerSnapshot[] }>("/api/listeners");
  return data.items;
}

// ---------- CF Temp Email (edu.002836.xyz) second provider ----------

export type CfAlias = {
  address: string;
  local: string;
  createdAt: string | null;
  forwardEnabled?: boolean;
  forwardTo?: string[];
};

export type CfMessageSummary = {
  uid: number;
  subject: string | null;
  from: string | null;
  to: string | null;
  date: string | null;
  preview: string | null;
};

export type CfMessageDetail = CfMessageSummary & {
  recipientHint?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
};

export type CfStatus = {
  configured: boolean;
  domain: string | null;
  error?: string;
  status?: any;
};

export type CfSendInput = {
  from: string;
  to: string[];
  subject?: string;
  body?: string;
  html?: boolean;
};

// 多 provider：所有临时邮箱函数都接受可选 providerId；不传 = 主源（兼容旧调用）。
export type TempProviderPublic = {
  id: string;
  name: string;
  type: "php" | "cf";
  endpoint: string;
  domain: string;
  hasPassword: boolean;
};

function pq(provider?: string): string {
  return provider ? `&provider=${encodeURIComponent(provider)}` : "";
}

export async function fetchCfProviders(): Promise<TempProviderPublic[]> {
  const data = await requestJson<{ items: TempProviderPublic[] }>("/api/cf/providers");
  return data.items;
}

export async function addCfProvider(input: {
  name: string;
  type?: "php" | "cf";
  endpoint: string;
  domain?: string;
  password: string;
}): Promise<TempProviderPublic> {
  return requestJson<TempProviderPublic>("/api/cf/providers", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function updateCfProvider(
  id: string,
  patch: { name?: string; type?: "php" | "cf"; endpoint?: string; domain?: string; password?: string }
): Promise<TempProviderPublic> {
  return requestJson<TempProviderPublic>(`/api/cf/providers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
}

export async function deleteCfProvider(id: string): Promise<void> {
  await requestJson(`/api/cf/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function fetchCfStatus(provider?: string): Promise<CfStatus> {
  return requestJson<CfStatus>(`/api/cf/status?_=1${pq(provider)}`);
}

export async function fetchCfAliases(provider?: string): Promise<CfAlias[]> {
  const data = await requestJson<{ items: CfAlias[] }>(`/api/cf/aliases?_=1${pq(provider)}`);
  return data.items;
}

export async function createCfAlias(local: string, provider?: string): Promise<CfAlias> {
  return requestJson<CfAlias>("/api/cf/aliases", {
    method: "POST",
    body: JSON.stringify({ local, provider })
  });
}

export async function deleteCfAlias(local: string, provider?: string): Promise<void> {
  await requestJson<{ success: boolean }>(`/api/cf/aliases/${encodeURIComponent(local)}?_=1${pq(provider)}`, {
    method: "DELETE"
  });
}

export async function fetchCfInbox(alias: string, provider?: string): Promise<CfMessageSummary[]> {
  const data = await requestJson<{ items: CfMessageSummary[] }>(
    `/api/cf/inbox?alias=${encodeURIComponent(alias)}${pq(provider)}`
  );
  return data.items;
}

export async function fetchCfMessage(alias: string, uid: number, provider?: string): Promise<CfMessageDetail> {
  return requestJson<CfMessageDetail>(
    `/api/cf/message?alias=${encodeURIComponent(alias)}&uid=${uid}${pq(provider)}`
  );
}

export async function sendCfMail(input: CfSendInput & { provider?: string }) {
  return requestJson("/api/cf/send", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export type CfForwarding = {
  enabled: boolean;
  forwardTo: string[];
  forwardedUids?: number[];
};

export async function fetchCfGlobalForwarding(provider?: string): Promise<CfForwarding> {
  return requestJson<CfForwarding>(`/api/cf/forwarding/global?_=1${pq(provider)}`);
}

export async function updateCfAliasForwarding(
  address: string,
  enabled: boolean,
  forwardTo: string[],
  provider?: string
): Promise<CfAlias[]> {
  const data = await requestJson<{ items: CfAlias[] }>("/api/cf/forwarding/alias", {
    method: "POST",
    body: JSON.stringify({ address, enabled, forwardTo, provider })
  });
  return data.items;
}

export async function updateCfGlobalForwarding(
  enabled: boolean,
  forwardTo: string[],
  provider?: string
): Promise<CfForwarding> {
  return requestJson<CfForwarding>("/api/cf/forwarding/global", {
    method: "POST",
    body: JSON.stringify({ enabled, forwardTo, provider })
  });
}

export type CfConfigStatus = {
  configured: boolean;
  endpoint: string;
  domain: string;
  hasPassword: boolean;
  source: "ui" | "env" | "none";
};

export async function fetchCfConfig(): Promise<CfConfigStatus> {
  return requestJson<CfConfigStatus>("/api/cf/config");
}

export async function saveCfConfig(input: {
  endpoint: string;
  domain?: string;
  password?: string;
}): Promise<CfConfigStatus> {
  return requestJson<CfConfigStatus>("/api/cf/config", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function clearCfConfig(): Promise<void> {
  await requestJson("/api/cf/config", { method: "DELETE" });
}

// ---------- AI 助手（右下角气泡） ----------

export type AiChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AiConfigStatus = {
  configured: boolean;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  source: "ui" | "env" | "none";
};

export async function fetchAiConfig(): Promise<AiConfigStatus> {
  return requestJson<AiConfigStatus>("/api/ai/config");
}

export async function saveAiConfig(input: {
  baseUrl: string;
  model?: string;
  apiKey?: string;
}): Promise<AiConfigStatus> {
  return requestJson<AiConfigStatus>("/api/ai/config", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export type SecretBundle = {
  temp: Array<{ id: string; name: string; type: "php" | "cf"; endpoint: string; domain: string; password: string | null }>;
  claw: { apiKey: string | null; hasCookie: boolean };
  ai: { apiKey: string | null };
};

export async function fetchSecrets(): Promise<SecretBundle> {
  return requestJson<SecretBundle>("/api/secrets");
}

export type ExtConfig = {
  pathPrefix: string;
  adminToken: string;
  sitePassword: string;
  webhookUrl: string;
  sendLimit: number;
  domains: string[];
};

export async function fetchExtConfig(): Promise<ExtConfig> {
  return requestJson<ExtConfig>("/api/ext/config");
}

export async function saveExtConfig(input: { regen?: boolean; sitePassword?: string; webhookUrl?: string; sendLimit?: number }): Promise<ExtConfig> {
  return requestJson<ExtConfig>("/api/ext/config", { method: "POST", body: JSON.stringify(input) });
}

export type AccessState = {
  failLimit: number;
  whitelist: string[];
  blacklist: string[];
  banned: Array<{ ip: string; at: number; reason: string }>;
  fails: Record<string, number>;
  currentIp: string;
};

export async function fetchAccess(): Promise<AccessState> {
  return requestJson<AccessState>("/api/access");
}

export async function accessAction(action: string, ip?: string): Promise<AccessState> {
  return requestJson<AccessState>("/api/access", { method: "POST", body: JSON.stringify({ action, ip }) });
}

export async function fetchAiModels(baseUrl?: string, apiKey?: string): Promise<string[]> {
  const data = await requestJson<{ models: string[] }>("/api/ai/models", {
    method: "POST",
    body: JSON.stringify({ baseUrl, apiKey })
  });
  return data.models;
}

export type ToolUndo = { tool: string; args: any; label_zh: string; label_en: string } | null;
export type ToolTraceItem = { name: string; args: any; result?: any; ok: boolean; undo?: ToolUndo };
export type ToolPlanItem = { name: string; args: any };

export async function aiChat(
  messages: AiChatMessage[],
  dryRun = true
): Promise<{ reply: string; toolTrace: ToolTraceItem[]; plan?: ToolPlanItem[] }> {
  return requestJson("/api/ai/chat", {
    method: "POST",
    body: JSON.stringify({ messages, dryRun })
  });
}

// 确认后直接执行已决定的 plan（不重跑 LLM，确认=执行）
export async function aiExec(plan: ToolPlanItem[]): Promise<{ toolTrace: ToolTraceItem[] }> {
  return requestJson("/api/ai/exec", { method: "POST", body: JSON.stringify({ plan }) });
}

// 直连标记已读/未读（AI 撤销 mark_read 走这个，不绕 LLM）
export async function markMails(mailbox: string, ids: string[], read: boolean): Promise<void> {
  await requestJson("/api/claw/mark", { method: "POST", body: JSON.stringify({ mailbox, ids, read }) });
}
