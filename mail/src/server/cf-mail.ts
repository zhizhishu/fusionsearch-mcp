// 临时邮箱 provider 客户端（多实例）。按 provider.type 分流：
//   - "php": 自建 PHP 临时邮箱（webhostmost / edu，X-Admin-Password，action=external_*）—— 全功能
//   - "cf" : cloudflare_temp_email (dreamhunter2333) 标准接口。canonical 契约：
//       建址:    POST /admin/new_address (头 x-admin-auth) → {jwt, address, password, address_id}
//       读信:    GET  /api/parsed_mails?limit=&offset= (头 Authorization: Bearer <该址 jwt>) → {results, count}
//                解析字段 = {id, message_id, source, address, sender, subject, text, html, created_at, attachments}
//       发信:    POST /admin/send_mail (头 x-admin-auth) {from_mail, to_mail, subject, content, is_html} → {status:"ok"}
//       列地址:  GET /admin/address?limit=&offset= (头 x-admin-auth) → {results:[{name,address,created_at,...}],count} 全量分页；
//          不可用(非 canonical)才退回面板本地记账(app_settings cf.addresses.<id>)。读某址先 mint 一把该址 jwt 再读 /api/parsed_mails。
//          ⚠ cfMint 依赖 new_address 同名幂等刷 jwt；真 canonical admin/new_address 对已存在地址可能非幂等，
//            待 roastalpha-cf 上线后改走 /admin/show_password/:id 或 /admin/mails?address= 实测校准。
import type { TempProvider } from "./temp-providers";
import { getSetting, setSetting } from "./db";

export type CfAlias = {
  address: string;
  local: string;
  createdAt: string | null;
  forwardEnabled?: boolean;
  forwardTo?: string[];
  id?: string | number;
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
export type CfSendInput = { from: string; to: string[]; subject?: string; body?: string; html?: boolean };
export type CfForwarding = { enabled: boolean; forwardTo: string[]; forwardedUids?: number[] };

function localOf(addr: string): string { return (addr || "").split("@")[0]; }
function fullAddr(provider: TempProvider, local: string): string {
  return local.includes("@") ? local : `${local}@${provider.domain}`;
}
function snippet(s: string | null | undefined, n = 140): string | null {
  if (!s) return null;
  const t = String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) : t;
}

/* ===================== php 类型 ===================== */
type PhpApiOptions = { method?: "GET" | "POST"; query?: Record<string, string | number | undefined>; body?: unknown; form?: Record<string, string | number | boolean | undefined> };
async function phpApi<T = any>(provider: TempProvider, action: string, options: PhpApiOptions = {}): Promise<T> {
  const url = new URL(provider.endpoint);
  url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { "X-Admin-Password": provider.password };
  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.form !== undefined) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(options.form)) if (v !== undefined) params.set(k, String(v));
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = params.toString(); init.method = "POST";
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json"; init.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `temp-mail HTTP ${res.status}`);
  return data as T;
}

/* ===================== cf 类型（cloudflare_temp_email 壳） ===================== */
// 本地记账：面板建过的地址前缀（cf 壳没有远端列表口子）
function cfNames(provider: TempProvider): string[] {
  try { const v = JSON.parse(getSetting(`cf.addresses.${provider.id}`) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function cfAddName(provider: TempProvider, local: string): void {
  const list = cfNames(provider);
  if (!list.includes(local)) { list.push(local); setSetting(`cf.addresses.${provider.id}`, JSON.stringify(list)); }
}
function cfRemoveName(provider: TempProvider, local: string): void {
  setSetting(`cf.addresses.${provider.id}`, JSON.stringify(cfNames(provider).filter((n) => n !== local)));
}

// 建/取地址：new_address 同名幂等 → 每次拿到新鲜 jwt（自动解决 24h 过期）
async function cfMint(provider: TempProvider, local: string): Promise<{ address: string; jwt: string; addressId?: string }> {
  const res = await fetch(provider.endpoint.replace(/\/+$/, "") + "/admin/new_address", {
    method: "POST",
    headers: { "x-admin-auth": provider.password, "content-type": "application/json" },
    body: JSON.stringify({ name: local, domain: provider.domain, enablePrefix: false })
  });
  const text = await res.text();
  let j: any = null; try { j = JSON.parse(text); } catch { /* */ }
  if (!res.ok || !j?.jwt) throw new Error(j?.error || j?.message || `cf new_address HTTP ${res.status}`);
  return { address: j.address || fullAddr(provider, local), jwt: j.jwt, addressId: j.address_id };
}

async function cfReadParsed(provider: TempProvider, local: string, limit = 50): Promise<any[]> {
  const { jwt } = await cfMint(provider, local);
  const res = await fetch(provider.endpoint.replace(/\/+$/, "") + `/api/parsed_mails?limit=${limit}`, {
    headers: { authorization: `Bearer ${jwt}` }
  });
  const text = await res.text();
  let j: any = null; try { j = JSON.parse(text); } catch { /* */ }
  if (!res.ok) throw new Error(j?.error || j?.message || `cf parsed_mails HTTP ${res.status}`);
  return Array.isArray(j) ? j : (j?.results ?? j?.mails ?? []);
}

// canonical cf parsed 字段：{id, sender, subject, text, html, source, address, created_at}
function cfMap(m: any, alias: string): CfMessageSummary {
  return {
    uid: Number(m.id ?? 0),
    subject: m.subject ?? null,
    from: m.sender ?? m.source ?? null,
    to: m.address ?? alias,
    date: m.created_at ?? null,
    preview: snippet(m.text)
  };
}

/* ===================== 对外统一接口（按 type 分流） ===================== */
export function cfDomain(provider: TempProvider): string { return provider.domain; }

export async function cfStatus(provider: TempProvider): Promise<any> {
  if (provider.type === "cf") {
    // 用只读 admin 端点 /admin/address 验证 x-admin-auth（200=通）。
    // ⚠ 不再 mint "healthcheck" 探针地址——那会往服务器地址表登记一条永久记录、反复污染列表
    //   （历史上 edu/roastalpha 的 healthcheck 就是这里反复建出来的）。
    const base = provider.endpoint.replace(/\/+$/, "");
    const res = await fetch(`${base}/admin/address?limit=1`, { headers: { "x-admin-auth": provider.password } });
    if (!res.ok) throw new Error(`cf admin auth check HTTP ${res.status}`);
    return { domain: provider.domain };
  }
  return phpApi(provider, "external_status");
}

// canonical cf：GET /admin/address 全量列地址（分页拉完），不再只靠面板本地记账。
async function cfAdminList(provider: TempProvider): Promise<CfAlias[]> {
  const base = provider.endpoint.replace(/\/+$/, "");
  const out: CfAlias[] = [];
  const seen = new Set<string>();
  const limit = 100;
  for (let page = 0, offset = 0; page < 100; page++, offset += limit) {
    const res = await fetch(`${base}/admin/address?limit=${limit}&offset=${offset}`, {
      headers: { "x-admin-auth": provider.password }
    });
    if (!res.ok) throw new Error(`cf admin/address HTTP ${res.status}`);
    const text = await res.text();
    let j: any = null;
    try { j = JSON.parse(text); } catch { /* */ }
    const results: any[] = Array.isArray(j?.results) ? j.results : [];
    for (const r of results) {
      const address = String(r.address || r.name || "");
      if (!address) continue;
      // 只列与本源域名一致的地址：服务器地址库可能残留旧/其它域名条目（如换域名前的 wahah.xyz），按 provider.domain 过滤掉
      if (provider.domain && (address.split("@")[1] || "").toLowerCase() !== provider.domain.toLowerCase()) continue;
      if (seen.has(address)) continue; // 按完整地址去重
      seen.add(address);
      // local = 服务器认的地址名（new_address 的 name）；缺则取地址本地部分
      out.push({ address, local: String(r.name ?? localOf(address)), createdAt: r.created_at ?? null });
    }
    if (results.length < limit) break;
  }
  return out;
}

export async function cfListAliases(provider: TempProvider): Promise<CfAlias[]> {
  if (provider.type === "cf") {
    // canonical /admin/address 是权威源，全量列；不可用才退回面板本地记账
    try {
      return await cfAdminList(provider);
    } catch {
      return cfNames(provider).map((n) => ({ address: fullAddr(provider, n), local: n, createdAt: null }));
    }
  }
  const data = await phpApi<{ aliases?: CfAlias[] }>(provider, "external_aliases");
  return data.aliases ?? [];
}

export async function cfInbox(provider: TempProvider, alias: string): Promise<CfMessageSummary[]> {
  if (provider.type === "cf") {
    const local = localOf(alias);
    cfAddName(provider, local); // 看过即记账，方便列表
    const mails = await cfReadParsed(provider, local);
    return mails.map((m) => cfMap(m, alias));
  }
  const data = await phpApi<{ messages?: CfMessageSummary[] }>(provider, "external_inbox", { query: { alias } });
  return data.messages ?? [];
}

// 出口列表用：带全量正文(text+html)，对齐 canonical /api/parsed_mails（列表也给完整 parsed，而非 preview 截断）。
// cf：一次 parsed_mails 全量本就含正文，零额外往返；php：摘要切片后逐封补全量。
export async function cfInboxRich(provider: TempProvider, alias: string, limit: number, offset: number): Promise<CfMessageDetail[]> {
  if (provider.type === "cf") {
    const mails = await cfReadParsed(provider, localOf(alias));
    return mails.slice(offset, offset + limit).map((m) => {
      const html: string | null = m.html ?? null;
      const body: string = m.text ?? "";
      return { ...cfMap(m, alias), bodyText: body || null, bodyHtml: html };
    });
  }
  const summaries = (await cfInbox(provider, alias)).slice(offset, offset + limit);
  const out: CfMessageDetail[] = [];
  for (const s of summaries) {
    try { out.push(await cfMessage(provider, alias, s.uid)); }
    catch { out.push({ ...s, bodyText: s.preview ?? null, bodyHtml: null }); }
  }
  return out;
}

export async function cfSent(provider: TempProvider, alias: string): Promise<CfMessageSummary[]> {
  if (provider.type === "cf") return []; // cf 壳无已发
  const data = await phpApi<{ messages?: CfMessageSummary[] }>(provider, "external_sent", { query: { alias } });
  return data.messages ?? [];
}

export async function cfSearch(
  provider: TempProvider,
  alias: string,
  query: { keyword?: string; from?: string; subject?: string; limit?: number }
): Promise<CfMessageSummary[]> {
  const messages = await cfInbox(provider, alias);
  const kw = query.keyword?.trim().toLowerCase();
  const fromQ = query.from?.trim().toLowerCase();
  const subjQ = query.subject?.trim().toLowerCase();
  return messages.filter((m) => {
    if (kw) { const hay = `${m.subject ?? ""}\n${m.from ?? ""}\n${m.preview ?? ""}`.toLowerCase(); if (!hay.includes(kw)) return false; }
    if (fromQ && !(m.from ?? "").toLowerCase().includes(fromQ)) return false;
    if (subjQ && !(m.subject ?? "").toLowerCase().includes(subjQ)) return false;
    return true;
  }).slice(0, query.limit ?? 50);
}

export async function cfMessage(provider: TempProvider, alias: string, uid: number): Promise<CfMessageDetail> {
  if (provider.type === "cf") {
    const mails = await cfReadParsed(provider, localOf(alias), 100);
    const m = mails.find((x) => Number(x.id) === Number(uid)) ?? {};
    const body: string = m.text ?? "";
    const html: string | null = m.html ?? null;
    return { ...cfMap(m, alias), bodyText: body || null, bodyHtml: html };
  }
  const data = await phpApi<{ message: CfMessageDetail }>(provider, "external_message", { query: { alias, uid } });
  return data.message;
}

export async function cfCreateAlias(provider: TempProvider, local: string): Promise<CfAlias> {
  if (provider.type === "cf") {
    const r = await cfMint(provider, local);
    cfAddName(provider, localOf(r.address));
    return { address: r.address, local: localOf(r.address), createdAt: null, id: r.addressId };
  }
  const data = await phpApi<{ alias?: CfAlias } & Partial<CfAlias>>(provider, "external_create_alias", { method: "POST", body: { local } });
  return data.alias ?? (data as CfAlias);
}

export async function cfDeleteAlias(provider: TempProvider, local: string): Promise<void> {
  if (provider.type === "cf") {
    // canonical 删除：先按 local 在 /admin/address 反查数字 id，再 DELETE /admin/delete_address/:id。
    // （edu/roastalpha 的 cf.php shim 2026-06-27 已补齐此 canonical 端点；之前 cf 壳无删除口、只能清本地记账。）
    const base = provider.endpoint.replace(/\/+$/, "");
    const target = localOf(local);
    let addrId: number | null = null;
    try {
      const res = await fetch(`${base}/admin/address?limit=1000&offset=0`, { headers: { "x-admin-auth": provider.password } });
      if (res.ok) {
        const j: any = await res.json().catch(() => null);
        const results: any[] = Array.isArray(j?.results) ? j.results : [];
        const row = results.find((r) => localOf(String(r.address || r.name || "")) === target || String(r.name) === target);
        if (row && row.id != null) addrId = Number(row.id);
      }
    } catch { /* 列表失败则跳过远端删除，至少清本地记账 */ }
    if (addrId != null) {
      const del = await fetch(`${base}/admin/delete_address/${addrId}`, {
        method: "DELETE",
        headers: { "x-admin-auth": provider.password }
      });
      if (!del.ok) throw new Error(`cf delete_address HTTP ${del.status}`);
    }
    cfRemoveName(provider, target); // 同步清面板本地记账
    return;
  }
  await phpApi(provider, "external_delete_alias", { method: "POST", body: { local } });
}

export async function cfSend(provider: TempProvider, input: CfSendInput): Promise<any> {
  if (provider.type === "cf") {
    // canonical cf 管理员发信：POST /admin/send_mail (x-admin-auth)，字段 {from_mail,to_mail,subject,content,is_html} → {status:"ok"}
    const res = await fetch(provider.endpoint.replace(/\/+$/, "") + "/admin/send_mail", {
      method: "POST",
      headers: { "x-admin-auth": provider.password, "content-type": "application/json" },
      body: JSON.stringify({
        from_mail: input.from,
        to_mail: input.to.join(","),
        subject: input.subject ?? "",
        content: input.body ?? "",
        is_html: Boolean(input.html)
      })
    });
    const text = await res.text();
    let j: any = null; try { j = JSON.parse(text); } catch { /* */ }
    if (!res.ok) throw new Error(j?.error || j?.message || `cf send_mail HTTP ${res.status}`);
    return j ?? { status: "ok" };
  }
  return phpApi(provider, "external_send", {
    method: "POST",
    body: { from: input.from, to: input.to, subject: input.subject ?? "", body: input.body ?? "", format: input.html ? "html" : "text" }
  });
}

export async function cfGlobalForwarding(provider: TempProvider): Promise<CfForwarding> {
  if (provider.type === "cf") return { enabled: false, forwardTo: [] };
  const data = await phpApi<{ forwarding: CfForwarding }>(provider, "external_global_forwarding");
  return data.forwarding;
}

export async function cfUpdateAliasForwarding(provider: TempProvider, address: string, enabled: boolean, forwardTo: string[]): Promise<CfAlias[]> {
  if (provider.type === "cf") throw new Error("cloudflare_temp_email 壳不支持转发设置");
  const data = await phpApi<{ aliases?: CfAlias[] }>(provider, "external_update_forwarding", {
    form: { address, enabled: enabled ? 1 : 0, forwardTo: forwardTo.join(",") }
  });
  return data.aliases ?? [];
}

export async function cfUpdateGlobalForwarding(provider: TempProvider, enabled: boolean, forwardTo: string[]): Promise<CfForwarding> {
  if (provider.type === "cf") throw new Error("cloudflare_temp_email 壳不支持转发设置");
  const data = await phpApi<{ forwarding: CfForwarding }>(provider, "external_update_global_forwarding", {
    form: { enabled: enabled ? 1 : 0, forwardTo: forwardTo.join(",") }
  });
  return data.forwarding;
}
