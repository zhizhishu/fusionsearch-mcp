import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  ADMIN_PASSWORD: z.string().min(1).default("change-me"),
  CLAW_API_KEY: z.string().optional(),
  CLAW_DASHBOARD_COOKIE: z.string().optional(),
  CLAW_WORKSPACE_ID: z.string().optional(),
  CLAW_PARENT_MAILBOX_ID: z.string().optional(),
  CLAW_ROOT_PREFIX: z.string().optional(),
  CLAW_DOMAIN: z.string().default("claw.163.com"),
  DATABASE_PATH: z.string().default("./data/app.db"),
  // CF Temp Email (webhostmost / edu.002836.xyz) second provider — optional.
  CF_TEMP_EMAIL_API_ENDPOINT: z.string().optional(),
  CF_TEMP_EMAIL_BASE_URL: z.string().optional(),
  CF_TEMP_EMAIL_DOMAIN: z.string().optional(),
  CF_TEMP_EMAIL_ADMIN_PASSWORD: z.string().optional(),
  // Supabase 持久化（可选）：把数据沉淀到 Supabase，解决 HF 易失存储重启丢数据。
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),
  // AI 助手（右下角气泡）——OpenAI 兼容端点，provider 无关。可在 UI 配置覆盖。
  AI_BASE_URL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional()
});

export const config = envSchema.parse(process.env);

export function requireClawApiKey(): string {
  if (!config.CLAW_API_KEY) {
    throw new Error("CLAW_API_KEY is required for mail operations");
  }
  return config.CLAW_API_KEY;
}

export function requireDashboardCookie(): string {
  if (!config.CLAW_DASHBOARD_COOKIE) {
    throw new Error("CLAW_DASHBOARD_COOKIE is required for mailbox management");
  }
  return config.CLAW_DASHBOARD_COOKIE;
}

export function normalizeMailboxEmail(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.includes("@")) {
    return trimmed;
  }
  return `${trimmed}@${config.CLAW_DOMAIN}`;
}

export function suffixToEmail(suffix: string): string {
  if (!config.CLAW_ROOT_PREFIX) {
    throw new Error("CLAW_ROOT_PREFIX is required to format mailbox addresses");
  }
  const root = config.CLAW_ROOT_PREFIX.trim().toLowerCase();
  return `${root}.${suffix}@${config.CLAW_DOMAIN}`;
}

export function cfTempMailConfigured(): boolean {
  return Boolean(
    (config.CF_TEMP_EMAIL_API_ENDPOINT || config.CF_TEMP_EMAIL_BASE_URL) &&
      config.CF_TEMP_EMAIL_ADMIN_PASSWORD
  );
}

export function cfTempMailEndpoint(): string {
  if (config.CF_TEMP_EMAIL_API_ENDPOINT) return config.CF_TEMP_EMAIL_API_ENDPOINT;
  const base = config.CF_TEMP_EMAIL_BASE_URL?.replace(/\/+$/, "");
  if (base) return `${base}/api.php`;
  throw new Error("CF_TEMP_EMAIL_API_ENDPOINT or CF_TEMP_EMAIL_BASE_URL is required");
}

export function requireCfTempMailPassword(): string {
  if (!config.CF_TEMP_EMAIL_ADMIN_PASSWORD) {
    throw new Error("CF_TEMP_EMAIL_ADMIN_PASSWORD is required for temp-mail operations");
  }
  return config.CF_TEMP_EMAIL_ADMIN_PASSWORD;
}
