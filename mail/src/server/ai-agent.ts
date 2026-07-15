// 右下角 AI 气泡的「大脑」：OpenAI 兼容的工具调用循环。
// 工具 = claw + edu 两个邮箱的参考功能（列信/读信/搜索/发信/回复/建别名）。
// LLM 端点 provider 无关，由 runtime-config 提供（UI/env 可配）。
import { getAiApiKey, getAiBaseUrl, getAiModel, aiConfigured, hasClawMailConfig } from "./runtime-config";
import { listProviders, getProvider, type TempProvider } from "./temp-providers";
import { listMailboxes, upsertMailbox } from "./db";
import { sendMail, replyMail, formatSdkError } from "./claw-mail";
import { listFolderMessages, getMessageSummaries, searchMessages, markMessages, readRemoteMailDetail } from "./claw-ops";
import { cfListAliases, cfInbox, cfMessage, cfSend, cfCreateAlias, cfSearch } from "./cf-mail";
import { createMailbox as createClawSubMailbox, updateMailboxCommunicationSettings } from "./claw-dashboard";
import { startMailboxListener } from "./listener-manager";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
};

const CLAW_DOMAIN = "claw.163.com";

function isClaw(address: string): boolean {
  return (address || "").toLowerCase().includes(`@${CLAW_DOMAIN}`);
}

// 按地址域名匹配临时邮箱源；匹配不到用主源。
function resolveTemp(address: string): TempProvider | undefined {
  const a = (address || "").toLowerCase();
  const list = listProviders();
  const at = a.indexOf("@");
  if (at >= 0) {
    const dom = a.slice(at + 1);
    const m = list.find((p) => p.domain.toLowerCase() === dom);
    if (m) return m;
  }
  return list[0];
}

function clip(s: string | null | undefined, n = 1500): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + `…(截断,共${s.length}字)` : s;
}

// ---------- 工具定义（OpenAI function-calling 格式）----------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_mailboxes",
      description: "列出当前所有邮箱：claw.163.com 子邮箱 + edu 临时邮箱别名。返回每个的地址和 provider。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "list_inbox",
      description: "列出某个邮箱收件箱里最近的邮件摘要（id/发件人/主题/时间）。claw 和 edu 都支持。",
      parameters: {
        type: "object",
        properties: {
          mailbox: { type: "string", description: "邮箱地址，如 echocq@claw.163.com 或 edu 别名地址" },
          limit: { type: "number", description: "最多返回几封，默认 15" }
        },
        required: ["mailbox"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_mail",
      description: "读取一封邮件的完整内容（正文+发件人+主题）。需要先用 list_inbox 拿到邮件 id。",
      parameters: {
        type: "object",
        properties: {
          mailbox: { type: "string", description: "邮箱地址" },
          id: { type: "string", description: "邮件 id（claw 是字符串 id，edu 是数字 uid）" }
        },
        required: ["mailbox", "id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_mail",
      description: "按关键词/发件人/主题搜索邮件。claw 走服务端全文检索；edu 临时邮箱拉收件箱后本地过滤。两者都支持。",
      parameters: {
        type: "object",
        properties: {
          mailbox: { type: "string", description: "邮箱地址（claw 或 edu 都行）" },
          query: { type: "string", description: "关键词" },
          from: { type: "string", description: "发件人过滤(可选)" },
          subject: { type: "string", description: "主题过滤(可选)" },
          limit: { type: "number", description: "默认 20" }
        },
        required: ["mailbox"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "send_mail",
      description: "发送一封新邮件。按 from 地址自动判断走 claw 还是 edu。发信前应先向用户确认收件人和内容。",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "发件邮箱地址（决定走 claw 还是 edu）" },
          to: { type: "array", items: { type: "string" }, description: "收件人列表" },
          subject: { type: "string" },
          body: { type: "string" },
          html: { type: "boolean", description: "body 是否为 HTML，默认 false" }
        },
        required: ["from", "to", "body"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "reply_mail",
      description: "回复一封 claw 邮件（自动保持线索）。仅 claw 支持。",
      parameters: {
        type: "object",
        properties: {
          mailbox: { type: "string", description: "claw 邮箱地址" },
          id: { type: "string", description: "原邮件 id" },
          body: { type: "string" },
          html: { type: "boolean" }
        },
        required: ["mailbox", "id", "body"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "mark_read",
      description: "把 claw 邮件标记为已读/未读。仅 claw 支持。",
      parameters: {
        type: "object",
        properties: {
          mailbox: { type: "string" },
          ids: { type: "array", items: { type: "string" } },
          read: { type: "boolean", description: "true=已读 false=未读，默认 true" }
        },
        required: ["mailbox", "ids"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_mailbox",
      description: "新建邮箱。claw：在工作区下建一个子邮箱（地址形如 <root>.<prefix>@claw.163.com，需已连接 Claw 后台）。edu：建一个临时邮箱别名（<prefix>@edu域）。",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["claw", "edu"], description: "claw=建子邮箱，edu=建临时别名" },
          prefix: { type: "string", description: "前缀（@前面那段，1-32位小写字母/数字）" }
        },
        required: ["provider", "prefix"]
      }
    }
  }
];

const DEFAULT_COMM = { commLevel: 2, extReceiveType: 1, extSendType: 1 } as const;

// 建 claw 子邮箱：复用路由那套流程（建→设通信档→落库→起监听）。
async function createClawMailbox(suffix: string) {
  if (!/^[a-z0-9]{1,32}$/.test(suffix)) throw new Error("前缀只能是 1-32 位小写字母或数字");
  const mb = await createClawSubMailbox(suffix);
  try { await updateMailboxCommunicationSettings(mb.id, DEFAULT_COMM); } catch { /* best-effort */ }
  const row = upsertMailbox({
    id: mb.id, email: mb.email, prefix: mb.prefix, displayName: mb.displayName,
    status: "active", openclawStatus: mb.openclawStatus, installCommand: mb.installCommand,
    authUrl: mb.authUrl, commLevel: DEFAULT_COMM.commLevel,
    extReceiveType: DEFAULT_COMM.extReceiveType, extSendType: DEFAULT_COMM.extSendType
  });
  startMailboxListener(row);
  return row;
}

// ---------- 工具执行 ----------
async function execTool(name: string, args: any): Promise<string> {
  try {
    switch (name) {
      case "list_mailboxes": {
        const claws = hasClawMailConfig()
          ? listMailboxes().filter((m) => m.status !== "deleted").map((m) => ({ address: m.email, provider: "claw" }))
          : [];
        const temps: any[] = [];
        for (const p of listProviders()) {
          try {
            const al = await cfListAliases(p);
            for (const a of al) temps.push({ address: a.address, provider: p.id, type: p.type });
          } catch { /* 某个源失败不影响其它 */ }
        }
        return JSON.stringify({ mailboxes: [...claws, ...temps] });
      }
      case "list_inbox": {
        const mailbox = String(args.mailbox);
        const limit = Math.min(Number(args.limit) || 15, 50);
        if (isClaw(mailbox)) {
          const sums = await listFolderMessages(mailbox, { fid: "INBOX", start: 0, limit, order: "date", desc: true });
          const infos = await getMessageSummaries(mailbox, sums.map((s) => s.id));
          const byId = new Map(infos.map((i) => [i.id, i]));
          const items = sums.map((s) => ({ id: s.id, from: byId.get(s.id)?.from ?? s.from, subject: byId.get(s.id)?.subject ?? s.subject, date: byId.get(s.id)?.date ?? s.date, read: s.read }));
          return JSON.stringify({ provider: "claw", items });
        }
        const p = resolveTemp(mailbox);
        if (!p) return JSON.stringify({ error: "没有可用的临时邮箱源" });
        const msgs = await cfInbox(p, mailbox);
        return JSON.stringify({ provider: p.id, items: msgs.slice(0, limit).map((m) => ({ id: m.uid, from: m.from, subject: m.subject, date: m.date, preview: clip(m.preview, 120) })) });
      }
      case "read_mail": {
        const mailbox = String(args.mailbox);
        if (isClaw(mailbox)) {
          const d = await readRemoteMailDetail(mailbox, String(args.id), false);
          return JSON.stringify({ provider: "claw", from: d.from, to: d.to, subject: d.subject, date: d.date, body: clip(d.text?.content || d.html?.content), attachments: (d.attachments ?? []).map((a) => a.filename) });
        }
        const p = resolveTemp(mailbox);
        if (!p) return JSON.stringify({ error: "没有可用的临时邮箱源" });
        const m = await cfMessage(p, mailbox, Number(args.id));
        return JSON.stringify({ provider: p.id, from: m.from, to: m.to, subject: m.subject, date: m.date, body: clip(m.bodyText || m.bodyHtml) });
      }
      case "search_mail": {
        const mailbox = String(args.mailbox);
        const limit = Math.min(Number(args.limit) || 20, 50);
        if (isClaw(mailbox)) {
          const items = await searchMessages(mailbox, { keyword: args.query, from: args.from, subject: args.subject, limit });
          return JSON.stringify({ provider: "claw", items: items.map((m) => ({ id: m.id, from: m.from, subject: m.subject, date: m.date })) });
        }
        const p = resolveTemp(mailbox);
        if (!p) return JSON.stringify({ error: "没有可用的临时邮箱源" });
        const items = await cfSearch(p, mailbox, { keyword: args.query, from: args.from, subject: args.subject, limit });
        return JSON.stringify({ provider: p.id, items: items.map((m) => ({ id: m.uid, from: m.from, subject: m.subject, date: m.date, preview: clip(m.preview, 120) })) });
      }
      case "send_mail": {
        const from = String(args.from);
        const to = Array.isArray(args.to) ? args.to.map(String) : [String(args.to)];
        if (isClaw(from)) {
          await sendMail({ from, to, subject: args.subject, body: args.body, html: Boolean(args.html) });
        } else {
          const p = resolveTemp(from);
          if (!p) return JSON.stringify({ error: "没有可用的临时邮箱源" });
          await cfSend(p, { from, to, subject: args.subject, body: args.body, html: Boolean(args.html) });
        }
        return JSON.stringify({ status: "sent", to });
      }
      case "reply_mail": {
        const mailbox = String(args.mailbox);
        if (!isClaw(mailbox)) return JSON.stringify({ error: "临时邮箱不支持线索回复，请用 send_mail" });
        await replyMail({ mailboxEmail: mailbox, providerMailId: String(args.id), body: args.body, html: Boolean(args.html) });
        return JSON.stringify({ status: "replied" });
      }
      case "mark_read": {
        const mailbox = String(args.mailbox);
        if (!isClaw(mailbox)) return JSON.stringify({ error: "仅 claw 支持标记已读" });
        const ids = (Array.isArray(args.ids) ? args.ids : [args.ids]).map(String);
        await markMessages(mailbox, ids, args.read !== false);
        return JSON.stringify({ status: "ok", marked: ids.length });
      }
      case "create_mailbox": {
        const prefix = String(args.prefix || "").trim();
        if (!prefix) return JSON.stringify({ error: "prefix 不能为空" });
        if (args.provider === "claw") {
          const row = await createClawMailbox(prefix);
          return JSON.stringify({ status: "created", provider: "claw", id: row.id, address: row.email });
        }
        const p = getProvider(args.tempProvider);
        if (!p) return JSON.stringify({ error: "没有可用的临时邮箱源" });
        const a = await cfCreateAlias(p, prefix);
        return JSON.stringify({ status: "created", provider: p.id, address: a.address, local: a.local || prefix });
      }
      default:
        return JSON.stringify({ error: `unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: formatSdkError(err) });
  }
}

const SYSTEM_PROMPT = `你是 ClawEmail 控制台里的邮箱助手，帮用户管理两类邮箱：claw.163.com 子邮箱、edu 临时邮箱。
- 用提供的工具去真实读/发/搜邮件，不要编造邮件内容。
- 列邮件先 list_inbox 拿 id，再 read_mail 读正文。
- 发信/回复属于会真实发出的动作：除非用户已明确说要发、且收件人和内容清楚，否则先把草稿给用户确认，不要擅自发。
- 回答简洁、列要点。涉及具体邮件就给出发件人/主题/时间。
- 必须用简体中文回答，绝对不要用繁体字。`;

async function callLLM(messages: ChatMessage[]): Promise<any> {
  const base = getAiBaseUrl();
  const key = getAiApiKey();
  const model = getAiModel();
  if (!base || !key) throw new Error("AI 未配置：请先在设置里填入模型端点(base_url)和 key");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: "auto", temperature: 0.3 })
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `AI 端点 HTTP ${res.status}`;
    try { const j = JSON.parse(text); msg = j.error?.message || j.message || msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  return JSON.parse(text);
}

// 拉取端点真实可用模型列表（GET {base}/models）。可传入未保存的 base/key 先试。
export async function listModels(baseUrl?: string, apiKey?: string): Promise<string[]> {
  const base = (baseUrl || getAiBaseUrl())?.replace(/\/+$/, "");
  const key = apiKey || getAiApiKey();
  if (!base) throw new Error("先填模型端点 base_url");
  if (!key) throw new Error("先填 API Key");
  const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
  const text = await res.text();
  if (!res.ok) {
    let msg = `拉取模型失败 HTTP ${res.status}`;
    try { const j = JSON.parse(text); msg = j.error?.message || j.message || msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  let j: any; try { j = JSON.parse(text); } catch { throw new Error("端点返回非 JSON（可能不支持 /models）"); }
  const arr: any[] = Array.isArray(j) ? j : (j.data ?? j.models ?? []);
  const ids = arr.map((m) => (typeof m === "string" ? m : m.id ?? m.name ?? m.model)).filter(Boolean);
  return Array.from(new Set(ids)).sort();
}

export type ToolUndo = { tool: string; args: any; label_zh: string; label_en: string } | null;
export type ToolTraceItem = { name: string; args: any; result?: any; ok: boolean; undo?: ToolUndo };
export type ToolPlanItem = { name: string; args: any };

// 有副作用、执行前要确认的工具
const DANGEROUS = new Set(["send_mail", "reply_mail", "create_mailbox"]);

// 为可逆动作产出"撤销描述"；不可逆/无副作用返回 null
function buildUndo(name: string, args: any, result: any): ToolUndo {
  switch (name) {
    case "create_mailbox":
      if (result?.provider === "claw" && result?.id)
        return { tool: "delete_mailbox_claw", args: { id: result.id }, label_zh: `删除邮箱 ${result.address}`, label_en: `Delete ${result.address}` };
      if (result?.local)
        return { tool: "delete_alias_temp", args: { local: result.local, provider: result.provider }, label_zh: `删除别名 ${result.address}`, label_en: `Delete ${result.address}` };
      return null;
    case "mark_read":
      return { tool: "mark_read", args: { mailbox: args.mailbox, ids: args.ids, read: args.read === false }, label_zh: "还原已读状态", label_en: "Revert read state" };
    default:
      return null;
  }
}

export async function runAgent(
  history: ChatMessage[],
  opts: { maxSteps?: number; dryRun?: boolean } = {}
): Promise<{ reply: string; toolTrace: ToolTraceItem[]; plan?: ToolPlanItem[] }> {
  if (!aiConfigured()) throw new Error("AI 未配置：请先在设置里填入模型端点(base_url)和 key");
  const maxSteps = opts.maxSteps ?? 6;
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];
  const toolTrace: ToolTraceItem[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const data = await callLLM(messages);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("AI 返回为空");
    messages.push(msg);

    const calls = msg.tool_calls;
    if (!calls || calls.length === 0) {
      return { reply: msg.content ?? "", toolTrace };
    }

    for (const call of calls) {
      let args: any = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* keep {} */ }
      // 预演模式：遇到危险动作不执行，返回待确认计划
      if (opts.dryRun && DANGEROUS.has(call.function.name)) {
        return { reply: msg.content ?? "", toolTrace, plan: [{ name: call.function.name, args }] };
      }
      const result = await execTool(call.function.name, args);
      let parsed: any = result;
      try { parsed = JSON.parse(result); } catch { /* keep raw string */ }
      const ok = !(parsed && typeof parsed === "object" && "error" in parsed);
      toolTrace.push({ name: call.function.name, args, result: parsed, ok, undo: ok ? buildUndo(call.function.name, args, parsed) : null });
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
    }
  }
  // 步数用尽，再要一次纯文本总结
  const finalData = await callLLM([...messages, { role: "user", content: "请基于以上工具结果，用简体中文（不要繁体字）给我最终回答。" }]);
  return { reply: finalData.choices?.[0]?.message?.content ?? "（达到最大步数）", toolTrace };
}

// 确认后按 dryRun 返回的 plan **直接执行**(不再重跑 LLM)，确保"确认卡上显示的=真正执行的"。
export async function execPlan(plan: ToolPlanItem[]): Promise<{ toolTrace: ToolTraceItem[] }> {
  const toolTrace: ToolTraceItem[] = [];
  for (const call of plan) {
    const args = call.args ?? {};
    const result = await execTool(call.name, args);
    let parsed: any = result;
    try { parsed = JSON.parse(result); } catch { /* keep raw */ }
    const ok = !(parsed && typeof parsed === "object" && "error" in parsed);
    toolTrace.push({ name: call.name, args, result: parsed, ok, undo: ok ? buildUndo(call.name, args, parsed) : null });
  }
  return { toolTrace };
}
