import { config } from "./config";
import { deleteSettings, getSetting, setSetting } from "./db";
import { addProvider, getProvider, removeProvider, tempConfigured, updateProvider } from "./temp-providers";

const AUTH_SETTING_KEYS = [
  "claw.apiKey",
  "claw.dashboardCookie",
  "claw.userEmail",
  "claw.workspaceId",
  "claw.workspaceName",
  "claw.parentMailboxId",
  "claw.rootPrefix",
  "claw.domain"
];

export function getClawApiKey(): string | undefined {
  return getSetting("claw.apiKey") ?? config.CLAW_API_KEY;
}

export function requireClawApiKey(): string {
  const value = getClawApiKey();
  if (!value) {
    throw new Error("CLAW_API_KEY is required for mail operations; connect Claw first");
  }
  return value;
}

export function getDashboardCookie(): string | undefined {
  return getSetting("claw.dashboardCookie") ?? config.CLAW_DASHBOARD_COOKIE;
}

export function requireDashboardCookie(): string {
  const value = getDashboardCookie();
  if (!value) {
    throw new Error("CLAW_DASHBOARD_COOKIE is required for mailbox management; connect Claw first");
  }
  return value;
}

export function getWorkspaceId(): string {
  const value = getStoredWorkspaceId();
  if (!value) {
    throw new Error("Claw workspace is not configured; connect Claw first");
  }
  return value;
}

export function getParentMailboxId(): string {
  const value = getStoredParentMailboxId();
  if (!value) {
    throw new Error("Claw parent mailbox is not configured; connect Claw first");
  }
  return value;
}

export function getRootPrefix(): string {
  const value = getStoredRootPrefix();
  if (!value) {
    throw new Error("Claw root prefix is not configured; connect Claw first");
  }
  return value;
}

export function getDomain(): string {
  return getStoredDomain();
}

export function hasClawMailConfig(): boolean {
  return Boolean(getClawApiKey());
}

export function hasClawDashboardConfig(): boolean {
  return Boolean(getDashboardCookie());
}

function getStoredWorkspaceId(): string | null {
  return getSetting("claw.workspaceId") ?? config.CLAW_WORKSPACE_ID ?? null;
}

function getStoredParentMailboxId(): string | null {
  return getSetting("claw.parentMailboxId") ?? config.CLAW_PARENT_MAILBOX_ID ?? null;
}

function getStoredRootPrefix(): string | null {
  return getSetting("claw.rootPrefix") ?? config.CLAW_ROOT_PREFIX ?? null;
}

function getStoredDomain(): string {
  return getSetting("claw.domain") ?? config.CLAW_DOMAIN;
}

export function getClawAuthStatus() {
  const apiKey = getClawApiKey();
  const cookie = getDashboardCookie();
  const workspaceId = cookie ? getStoredWorkspaceId() : null;
  const parentMailboxId = cookie ? getStoredParentMailboxId() : null;
  const rootPrefix = cookie ? getStoredRootPrefix() : null;
  const domain = cookie ? getStoredDomain() : null;
  return {
    connected: Boolean(apiKey && cookie && workspaceId && parentMailboxId && rootPrefix && domain),
    hasApiKey: Boolean(apiKey),
    hasDashboardCookie: Boolean(cookie),
    userEmail: getSetting("claw.userEmail") ?? null,
    workspaceId,
    workspaceName: getSetting("claw.workspaceName") ?? null,
    parentMailboxId,
    rootPrefix,
    domain,
    apiKeyPrefix: apiKey ? apiKey.slice(0, 10) : null,
    apiKeySuffix: apiKey ? apiKey.slice(-4) : null
  };
}

export function saveClawAuthSettings(input: {
  apiKey: string;
  dashboardCookie: string;
  userEmail?: string | null;
  workspaceId: string;
  workspaceName?: string | null;
  parentMailboxId: string;
  rootPrefix: string;
  domain: string;
}): void {
  setSetting("claw.apiKey", input.apiKey);
  setSetting("claw.dashboardCookie", input.dashboardCookie);
  setSetting("claw.workspaceId", input.workspaceId);
  setSetting("claw.parentMailboxId", input.parentMailboxId);
  setSetting("claw.rootPrefix", input.rootPrefix);
  setSetting("claw.domain", input.domain);
  if (input.userEmail) setSetting("claw.userEmail", input.userEmail);
  if (input.workspaceName) setSetting("claw.workspaceName", input.workspaceName);
}

export function clearClawAuthSettings(): void {
  deleteSettings(AUTH_SETTING_KEYS);
}

// ---------- 临时邮箱（多 provider；见 temp-providers.ts）----------
// 旧的「单配置」表单/接口仍可用，作用于「主 provider」（列表第一个），
// 向后兼容现有 edu；新增/管理多个源走 temp-providers 的 add/update/remove。
// 密码只写不回显。

export function cfConfigured(): boolean {
  return tempConfigured();
}

export function getCfDomain(): string {
  return getProvider()?.domain ?? "";
}

export function getCfConfigStatus() {
  const primary = getProvider();
  return {
    configured: Boolean(primary),
    endpoint: primary?.endpoint ?? "",
    domain: primary?.domain ?? "",
    hasPassword: Boolean(primary?.password),
    source: primary ? (primary.id === "edu" ? "env" : "ui") : "none"
  };
}

export function saveCfConfig(input: {
  endpoint: string;
  domain?: string | null;
  password?: string | null;
}): void {
  const primary = getProvider();
  if (primary) {
    updateProvider(primary.id, {
      endpoint: input.endpoint,
      domain: input.domain ?? undefined,
      password: input.password ?? undefined
    });
  } else {
    addProvider({
      name: (input.domain ?? "").trim() || "temp",
      type: "php",
      endpoint: input.endpoint,
      domain: input.domain ?? "",
      password: input.password ?? ""
    });
  }
}

export function clearCfConfig(): void {
  const primary = getProvider();
  if (primary) removeProvider(primary.id);
}

// ---------- AI 助手（右下角气泡）配置 ----------
// OpenAI 兼容端点（base_url + key + model），provider 无关。UI 可配，存 app_settings
// （随 Supabase 持久化），env 兜底。api key 只写不回显。

const AI_SETTING_KEYS = ["ai.baseUrl", "ai.apiKey", "ai.model"];
const DEFAULT_AI_MODEL = "gpt-4o-mini";

export function getAiBaseUrl(): string | undefined {
  const v = getSetting("ai.baseUrl") ?? config.AI_BASE_URL;
  return v?.replace(/\/+$/, "");
}

export function getAiApiKey(): string | undefined {
  return getSetting("ai.apiKey") ?? config.AI_API_KEY;
}

export function getAiModel(): string {
  return getSetting("ai.model") ?? config.AI_MODEL ?? DEFAULT_AI_MODEL;
}

export function aiConfigured(): boolean {
  return Boolean(getAiBaseUrl() && getAiApiKey());
}

export function getAiConfigStatus() {
  const baseUrl = getAiBaseUrl();
  const hasKey = Boolean(getAiApiKey());
  const fromSettings = Boolean(getSetting("ai.baseUrl") || getSetting("ai.apiKey"));
  // 只回显用户/env 真正设过的模型；没设就返回空，避免 UI 凭空冒出 gpt-4o-mini 默认值。
  // （实际调用 getAiModel() 仍有 DEFAULT_AI_MODEL 兜底，不影响气泡可用。）
  return {
    configured: Boolean(baseUrl && hasKey),
    baseUrl: baseUrl ?? "",
    model: getSetting("ai.model") ?? config.AI_MODEL ?? "",
    hasKey,
    source: fromSettings ? "ui" : baseUrl || hasKey ? "env" : "none"
  };
}

export function saveAiConfig(input: {
  baseUrl: string;
  model?: string | null;
  apiKey?: string | null;
}): void {
  setSetting("ai.baseUrl", input.baseUrl.trim().replace(/\/+$/, ""));
  if (input.model && input.model.trim()) setSetting("ai.model", input.model.trim());
  // 只在传入非空时覆盖 key，方便改 baseUrl/model 时不必重输密钥。
  if (input.apiKey && input.apiKey.trim()) setSetting("ai.apiKey", input.apiKey.trim());
}

export function clearAiConfig(): void {
  deleteSettings(AI_SETTING_KEYS);
}
