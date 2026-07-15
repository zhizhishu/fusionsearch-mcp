import { getParentMailboxId, getWorkspaceId, requireDashboardCookie } from "./runtime-config";

export type ClawMailbox = {
  id: string;
  email: string;
  prefix: string;
  displayName?: string | null;
  mailboxType?: string | null;
  status?: string | null;
  openclawStatus?: string | null;
  installCommand?: string | null;
  authUrl?: string | null;
  commLevel?: number | null;
  extReceiveType?: number | null;
  extSendType?: number | null;
  createdAt?: string | null;
};

export type ClawWorkspace = {
  id: string;
  name: string;
  type?: string;
  status?: string;
};

export type ClawApiKey = {
  keyId: string;
  name: string;
  status: string;
  defaultFlag?: number;
  apiKey: string;
  keyPrefix?: string;
  keySuffix?: string;
};

export type ClawUser = {
  email?: string;
  emailAddress?: string;
  [key: string]: unknown;
};

type DashboardEnvelope<T> = {
  code: number;
  message: string;
  success: boolean;
  result: T;
};

const DASHBOARD_ORIGIN = "https://claw.163.com";
const BASE_URL = `${DASHBOARD_ORIGIN}/mailserv-claw-dashboard/api/v1`;
const PUBLIC_BASE_URL = `${DASHBOARD_ORIGIN}/mailserv-claw-dashboard/p/v1`;

function getHeaders(): HeadersInit {
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    cookie: requireDashboardCookie()
  };
}

function extractAuthUrl(command?: string | null): string | null {
  if (!command) return null;
  const match = command.match(/--auth-url\s+"([^"]+)"/);
  return match?.[1] ?? null;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function normalizeMailbox(raw: any): ClawMailbox {
  return {
    id: String(raw.id),
    email: String(raw.email),
    prefix: String(raw.prefix ?? raw.email?.split("@")[0] ?? ""),
    displayName: raw.displayName ?? null,
    mailboxType: raw.mailboxType ?? null,
    status: raw.status ?? null,
    openclawStatus: raw.openclawStatus ?? null,
    installCommand: raw.installCommand ?? null,
    authUrl: extractAuthUrl(raw.installCommand),
    commLevel: optionalNumber(raw.commLevel),
    extReceiveType: optionalNumber(raw.extReceiveType),
    extSendType: optionalNumber(raw.extSendType),
    createdAt: raw.createdAt ?? null
  };
}

export async function parseDashboardResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text.trim()) {
    if (!response.ok) {
      throw new Error(`Claw dashboard error: ${response.statusText || response.status}`);
    }
    return undefined as T;
  }
  let body: DashboardEnvelope<T>;
  try {
    body = JSON.parse(text) as DashboardEnvelope<T>;
  } catch {
    throw new Error(`Claw dashboard returned non-JSON response: HTTP ${response.status}`);
  }
  if (!response.ok || body.success !== true || body.code !== 200) {
    throw new Error(`Claw dashboard error: ${body.message || response.statusText}`);
  }
  return body.result;
}

function cookieHeaderFromSetCookie(headers: string[]): string {
  return headers
    .map((header) => header.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

function readSetCookie(response: Response): string {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
    raw?: () => Record<string, string[]>;
  };
  const setCookieHeaders =
    headers.getSetCookie?.() ??
    headers.raw?.()["set-cookie"] ??
    [];
  const cookie = cookieHeaderFromSetCookie(setCookieHeaders);
  if (cookie) return cookie;

  const single = response.headers.get("set-cookie");
  if (single) return cookieHeaderFromSetCookie([single]);
  return "";
}

function authHeaders(cookie?: string): HeadersInit {
  return {
    accept: "application/json, text/plain, */*",
    cookie: cookie ?? requireDashboardCookie()
  };
}

export async function sendLoginCode(email: string): Promise<void> {
  const response = await fetch(`${PUBLIC_BASE_URL}/auth/email/send-code`, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      referer: `${DASHBOARD_ORIGIN}/projects/dashboard/`
    },
    body: JSON.stringify({ email })
  });
  await parseDashboardResponse<unknown>(response);
}

export async function verifyLoginCode(email: string, code: string): Promise<string> {
  const response = await fetch(`${PUBLIC_BASE_URL}/auth/email/verify-code`, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      referer: `${DASHBOARD_ORIGIN}/projects/dashboard/`
    },
    body: JSON.stringify({ email, code })
  });
  await parseDashboardResponse<unknown>(response);
  const cookie = readSetCookie(response);
  if (!cookie) {
    throw new Error("Claw login did not return a session cookie");
  }
  return cookie;
}

export async function getAuthMe(cookie?: string): Promise<ClawUser | null> {
  const response = await fetch(`${BASE_URL}/auth/me`, {
    method: "GET",
    headers: authHeaders(cookie)
  });
  return await parseDashboardResponse<ClawUser | null>(response);
}

export async function listWorkspaces(cookie?: string): Promise<ClawWorkspace[]> {
  const response = await fetch(`${BASE_URL}/workspaces`, {
    method: "GET",
    headers: authHeaders(cookie)
  });
  const result = await parseDashboardResponse<any>(response);
  return Array.isArray(result?.workspaces) ? result.workspaces : [];
}

export async function listApiKeys(cookie?: string): Promise<ClawApiKey[]> {
  const response = await fetch(`${BASE_URL}/api-keys`, {
    method: "GET",
    headers: authHeaders(cookie)
  });
  const result = await parseDashboardResponse<any>(response);
  const candidates =
    Array.isArray(result?.apiKeys) ? result.apiKeys :
    Array.isArray(result?.items) ? result.items :
    Array.isArray(result) ? result :
    [];
  return candidates.filter((item: any) => typeof item?.apiKey === "string");
}

export async function createMailbox(suffix: string): Promise<ClawMailbox> {
  const normalized = suffix.trim().toLowerCase();
  if (!/^[a-z0-9]{1,32}$/.test(normalized)) {
    throw new Error("suffix must contain 1-32 lowercase letters or digits");
  }

  const response = await fetch(`${BASE_URL}/mailboxes`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      prefix: normalized,
      displayName: normalized,
      mailboxType: "sub",
      workspaceId: getWorkspaceId(),
      parentMailboxId: getParentMailboxId()
    })
  });

  return normalizeMailbox(await parseDashboardResponse<any>(response));
}

export async function deleteMailbox(id: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/mailboxes/delete?id=${encodeURIComponent(id)}`, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      cookie: requireDashboardCookie()
    }
  });
  await parseDashboardResponse<null>(response);
}

export async function updateMailboxCommunicationSettings(
  id: string,
  input: {
    commLevel: number;
    extReceiveType?: number;
    extSendType?: number;
  }
): Promise<void> {
  const response = await fetch(`${BASE_URL}/mailboxes/comm-settings?id=${encodeURIComponent(id)}`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(input)
  });
  await parseDashboardResponse<null>(response);
}

export async function listDashboardMailboxes(input: {
  cookie?: string;
  workspaceId?: string;
} = {}): Promise<ClawMailbox[]> {
  const response = await fetch(`${BASE_URL}/mailboxes?workspaceId=${encodeURIComponent(input.workspaceId ?? getWorkspaceId())}`, {
    method: "GET",
    headers: {
      accept: "application/json, text/plain, */*",
      cookie: input.cookie ?? requireDashboardCookie()
    }
  });
  const result = await parseDashboardResponse<any>(response);
  if (result?.mailbox) {
    const primary = normalizeMailbox(result.mailbox);
    const children = Array.isArray(result.mailbox.subMailboxes)
      ? result.mailbox.subMailboxes.map(normalizeMailbox)
      : [];
    return [primary, ...children];
  }
  const candidates =
    Array.isArray(result) ? result :
    Array.isArray(result?.items) ? result.items :
    Array.isArray(result?.list) ? result.list :
    Array.isArray(result?.mailboxes) ? result.mailboxes :
    [];
  return candidates.map(normalizeMailbox);
}
