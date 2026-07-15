// Claw 邮箱「能力层」：把 @clawemail/node-sdk 内部 transport 藏起来的全套
// 操作（文件夹 / 列信 / 全文搜索 / 已读未读 / 移动 / 转发 / 按需读信）正经
// 包成有类型的服务端函数。面板、模型/脚本接口、AI 自动回复三处共用这一层，
// 不再各自 `as unknown` 去够私有字段。
//
// 已验证（2026-06-22，生产环境只读实测全绿）：
//   token / im-token / mbox:getAllFolders / listMessages / getMessageInfos /
//   readMessage / searchMessages / WS 实时握手 均可用。
import type { MailDetail } from "@clawemail/node-sdk";
import { getMailClient } from "./claw-mail";

export interface ClawFolder {
  id: string;
  name: string;
  unreadCount?: number;
}

export interface ClawMessageSummary {
  id: string;
  from?: string;
  subject?: string;
  date?: string;
  size?: number;
  read?: boolean;
}

export interface ClawMessageDetails extends ClawMessageSummary {
  to?: string;
  cc?: string;
  snippet?: string;
}

export interface ClawListOptions {
  fid: string | number;
  order?: string;
  desc?: boolean;
  limit?: number;
  start?: number;
  unread?: boolean;
}

export interface ClawSearchQuery {
  fid?: string | number;
  keyword?: string;
  from?: string;
  to?: string;
  subject?: string;
  since?: string;
  before?: string;
  unread?: boolean;
  fts?: boolean;
  limit?: number;
}

export type ClawForwardMode = "quote" | "attach" | "transmit";

export interface ClawForwardInput {
  id: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  body?: string;
  html?: boolean;
  mode?: ClawForwardMode;
}

// SDK 内部 transport（AjaxTransport）实现了这些方法，但没从包根导出，
// 也没挂到 MailClient 的公开类型上。这里给一个精确的局部接口去够它。
interface ClawTransport {
  kind: "ajax" | "imap";
  listFolders(): Promise<ClawFolder[]>;
  listMessages(options: ClawListOptions): Promise<ClawMessageSummary[]>;
  getMessage(ids: string | string[]): Promise<ClawMessageDetails[]>;
  searchMessages(query: ClawSearchQuery): Promise<ClawMessageSummary[]>;
  moveMessages(ids: string[], target: string | number): Promise<void>;
  markMessages(ids: string[], flags: { read?: boolean }): Promise<void>;
  forwardMessage(msg: ClawForwardInput): Promise<{ status: "sent" }>;
}

function getTransport(email: string): ClawTransport {
  const transport = (getMailClient(email) as unknown as { transport?: ClawTransport }).transport;
  if (!transport || typeof transport.listFolders !== "function") {
    throw new Error("当前安装的 Claw SDK 不支持高级邮箱操作（transport 不可用）");
  }
  return transport;
}

/** 列出邮箱所有文件夹（含未读计数）。 */
export async function listFolders(email: string): Promise<ClawFolder[]> {
  return getTransport(email).listFolders();
}

/** 按文件夹分页列出邮件摘要（按需，不落库）。 */
export async function listFolderMessages(email: string, options: ClawListOptions): Promise<ClawMessageSummary[]> {
  return getTransport(email).listMessages(options);
}

/** 批量取邮件摘要（from/subject/snippet 等），用于补全列表项。 */
export async function getMessageSummaries(email: string, ids: string[]): Promise<ClawMessageDetails[]> {
  if (ids.length === 0) return [];
  return getTransport(email).getMessage(ids);
}

/** 服务端搜索：keyword 走全文（fts），或按 from/to/subject/日期 结构化过滤。 */
export async function searchMessages(email: string, query: ClawSearchQuery): Promise<ClawMessageSummary[]> {
  return getTransport(email).searchMessages({
    fid: query.fid ?? "INBOX",
    keyword: query.keyword,
    from: query.from,
    to: query.to,
    subject: query.subject,
    since: query.since,
    before: query.before,
    unread: query.unread,
    fts: query.fts ?? Boolean(query.keyword),
    limit: query.limit ?? 50
  });
}

/** 标记已读 / 未读。 */
export async function markMessages(email: string, ids: string[], read: boolean): Promise<void> {
  if (ids.length === 0) return;
  await getTransport(email).markMessages(ids, { read });
}

/** 把邮件移动到目标文件夹（如 "Trash" / "INBOX" / 数字 fid）。 */
export async function moveMessages(email: string, ids: string[], target: string | number): Promise<void> {
  if (ids.length === 0) return;
  await getTransport(email).moveMessages(ids, target);
}

/** 转发邮件。mode: quote 引用正文 / attach 作附件 / transmit 密送原文。 */
export async function forwardMail(email: string, input: ClawForwardInput): Promise<{ status: "sent" }> {
  if (!input.to?.length) {
    throw new Error("转发收件人 to 不能为空");
  }
  return getTransport(email).forwardMessage(input);
}

/** 按需读取远端某封邮件完整内容（默认不改已读状态）。 */
export async function readRemoteMailDetail(
  email: string,
  providerMailId: string,
  markRead = false
): Promise<MailDetail> {
  return getMailClient(email).mail.read({ id: providerMailId, markRead });
}
