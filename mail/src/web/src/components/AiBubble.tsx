import { useEffect, useRef, useState } from "react";
import { usePrefs } from "../i18n";
import { aiChat, aiExec, markMails, fetchAiConfig, saveAiConfig, deleteMailbox, deleteCfAlias, type AiConfigStatus, type ToolTraceItem, type ToolPlanItem, type ToolUndo } from "../api";

type DisplayMsg = { role: "user" | "assistant"; content: string; trace?: ToolTraceItem[] };

// 每个工具：图标 + 是否危险(有副作用)
const TOOL_META: Record<string, { icon: string; danger: boolean }> = {
  list_mailboxes: { icon: "📭", danger: false },
  list_inbox: { icon: "📥", danger: false },
  read_mail: { icon: "✉️", danger: false },
  search_mail: { icon: "🔍", danger: false },
  send_mail: { icon: "📤", danger: true },
  reply_mail: { icon: "↩️", danger: true },
  mark_read: { icon: "✓", danger: false },
  create_mailbox: { icon: "➕", danger: true },
  create_edu_alias: { icon: "➕", danger: true }
};

function describeTool(t: ToolTraceItem, zh: boolean): string {
  const a = t.args ?? {};
  const mb = a.mailbox || a.from || "";
  switch (t.name) {
    case "list_mailboxes": return zh ? "列出全部邮箱" : "List mailboxes";
    case "list_inbox": return zh ? `列收件箱 · ${mb}` : `Inbox · ${mb}`;
    case "read_mail": return zh ? `读信 #${a.id ?? ""} · ${mb}` : `Read #${a.id ?? ""} · ${mb}`;
    case "search_mail": return zh ? `搜「${a.query ?? ""}」· ${mb}` : `Search "${a.query ?? ""}" · ${mb}`;
    case "send_mail": return zh ? `发信 → ${(a.to ?? []).join(", ")}` : `Send → ${(a.to ?? []).join(", ")}`;
    case "reply_mail": return zh ? `回复 #${a.id ?? ""} · ${mb}` : `Reply #${a.id ?? ""} · ${mb}`;
    case "mark_read": return zh ? `标已读 · ${(a.ids ?? []).length} 封` : `Mark read · ${(a.ids ?? []).length}`;
    case "create_mailbox":
    case "create_edu_alias": return zh ? `新建邮箱 ${a.prefix ?? a.local ?? ""}` : `New mailbox ${a.prefix ?? a.local ?? ""}`;
    default: return t.name;
  }
}

function resultSummary(t: ToolTraceItem, zh: boolean): string {
  if (!t.ok) return (t.result && t.result.error) || (zh ? "失败" : "failed");
  const r = t.result ?? {};
  if (Array.isArray(r.items)) return zh ? `${r.items.length} 条` : `${r.items.length} items`;
  if (Array.isArray(r.mailboxes)) return zh ? `${r.mailboxes.length} 个邮箱` : `${r.mailboxes.length} mailboxes`;
  if (r.status === "sent") return zh ? "已发送" : "sent";
  if (r.status === "replied") return zh ? "已回复" : "replied";
  if (r.status === "created") return r.address || (zh ? "已创建" : "created");
  return zh ? "完成" : "done";
}

export function AiBubble() {
  const { lang } = usePrefs();
  const T = (zh: string, en: string) => (lang === "zh" ? zh : en);

  const [open, setOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [config, setConfig] = useState<AiConfigStatus | null>(null);
  const [messages, setMessages] = useState<DisplayMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingPlan, setPendingPlan] = useState<{ plan: ToolPlanItem[]; history: { role: "user" | "assistant"; content: string }[] } | null>(null);
  const [undoStack, setUndoStack] = useState<NonNullable<ToolUndo>[]>([]);

  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [savedFlash, setSavedFlash] = useState("");

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open && !config) void loadConfig();
    if (open) setTimeout(() => inputRef.current?.focus(), 120);
  }, [open]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: 1e9, behavior: "smooth" });
  }, [messages, busy]);

  async function loadConfig() {
    try {
      const c = await fetchAiConfig();
      setConfig(c);
      setBaseUrl(c.baseUrl);
      setModel(c.model);
      if (!c.configured) setShowSettings(true);
    } catch {
      /* ignore */
    }
  }

  async function handleSaveConfig() {
    setError("");
    try {
      const c = await saveAiConfig({ baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey || undefined });
      setConfig(c);
      setApiKey("");
      setSavedFlash(T("已保存", "Saved"));
      setTimeout(() => setSavedFlash(""), 2000);
      if (c.configured) setShowSettings(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || busy) return;
    setError("");
    setInput("");
    const next: DisplayMsg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setBusy(true);
    try {
      const hist = next.map((m) => ({ role: m.role, content: m.content }));
      const res = await aiChat(hist, true); // 先预演：危险动作返回计划等确认
      if (res.plan && res.plan.length > 0) {
        setPendingPlan({ plan: res.plan, history: hist });
        if (res.reply) setMessages([...next, { role: "assistant", content: res.reply, trace: res.toolTrace ?? [] }]);
      } else {
        finalizeReply(next, res);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function finalizeReply(base: DisplayMsg[], res: { reply: string; toolTrace?: ToolTraceItem[] }) {
    setMessages([...base, { role: "assistant", content: res.reply || T("（没有返回内容）", "(no content)"), trace: res.toolTrace ?? [] }]);
    const undos = (res.toolTrace ?? []).map((t) => t.undo).filter(Boolean) as NonNullable<ToolUndo>[];
    if (undos.length) setUndoStack((s) => [...s, ...undos]);
  }

  async function handleConfirm() {
    if (!pendingPlan || busy) return;
    const plan = pendingPlan.plan;
    setPendingPlan(null);
    setBusy(true);
    setError("");
    try {
      const res = await aiExec(plan); // 直接执行已确认的 plan，不重跑 LLM → 确认的=执行的
      setMessages((cur) => [...cur, { role: "assistant", content: T("已执行", "Done"), trace: res.toolTrace ?? [] }]);
      const undos = (res.toolTrace ?? []).map((t) => t.undo).filter(Boolean) as NonNullable<ToolUndo>[];
      if (undos.length) setUndoStack((s) => [...s, ...undos]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleUndo() {
    const top = undoStack[undoStack.length - 1];
    if (!top || busy) return;
    setBusy(true);
    setError("");
    try {
      if (top.tool === "delete_mailbox_claw") await deleteMailbox(top.args.id);
      else if (top.tool === "delete_alias_temp") await deleteCfAlias(top.args.local, top.args.provider);
      else if (top.tool === "mark_read") {
        await markMails(top.args.mailbox, top.args.ids ?? [], top.args.read); // 直连，不绕 LLM
      }
      setUndoStack((s) => s.slice(0, -1));
      setMessages((m) => [...m, { role: "assistant", content: T(`已撤销：${top.label_zh}`, `Undone: ${top.label_en}`) }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const suggestions = [
    T("我有哪些邮箱？", "What mailboxes do I have?"),
    T("看看 echocq 收件箱最新的信", "Latest mail in echocq inbox"),
    T("搜一下含「验证码」的邮件", "Search mail for 'code'")
  ];

  return (
    <>
      {!open && (
        <button className="ai-fab" onClick={() => setOpen(true)} aria-label="AI assistant" title="AI">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" />
            <path d="M19 14.5l.8 2 .2.1 2 .8-2 .8-.2.1-.8 2-.8-2-.1-.1-2-.8 2-.8.1-.1.8-2z" />
          </svg>
        </button>
      )}

      {open && (
        <div className="ai-panel" role="dialog" aria-label="AI assistant">
          <header className="ai-head">
            <div className="ai-head-title">
              <span className="ai-dot" />
              <strong>{T("邮箱助手", "Mail Assistant")}</strong>
              <span className="ai-sub">
                {config?.configured ? (config.model || "AI") : T("未配置", "not set up")}
              </span>
            </div>
            <div className="ai-head-actions">
              <button className="ai-icon-btn" title={T("设置", "Settings")} onClick={() => setShowSettings((s) => !s)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.14.31.43.54.78.66H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
              </button>
              {messages.length > 0 && (
                <button className="ai-icon-btn" title={T("清空", "Clear")} onClick={() => setMessages([])}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
                </button>
              )}
              <button className="ai-icon-btn" title={T("收起", "Close")} onClick={() => setOpen(false)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>
            </div>
          </header>

          {showSettings ? (
            <div className="ai-settings">
              <p className="ai-settings-hint">
                {T("填入任意 OpenAI 兼容端点（你自己的模型源），气泡就能用自然语言操作两个邮箱。", "Point to any OpenAI-compatible endpoint to drive both mailboxes in natural language.")}
              </p>
              <label className="ai-field">
                <span>Base URL</span>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} />
              </label>
              <label className="ai-field">
                <span>{T("模型", "Model")}</span>
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={T("模型名（设置页可一键获取）", "model name")} spellCheck={false} />
              </label>
              <label className="ai-field">
                <span>API Key {config?.hasKey ? T("（已存，留空不改）", "(saved, blank = keep)") : ""}</span>
                <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" spellCheck={false} />
              </label>
              {error && <div className="ai-err">{error}</div>}
              <div className="ai-settings-actions">
                {savedFlash && <span className="ai-saved">{savedFlash}</span>}
                <button className="ai-btn-primary" onClick={handleSaveConfig} disabled={!baseUrl.trim()}>{T("保存", "Save")}</button>
              </div>
            </div>
          ) : (
            <>
              <div className="ai-msgs" ref={listRef}>
                {messages.length === 0 && (
                  <div className="ai-empty">
                    <div className="ai-empty-spark">✦</div>
                    {config && !config.configured ? (
                      <>
                        <p>{T("还没配模型，气泡动不了。点下面填 API 地址 + 令牌：", "No model yet. Set the API URL + key first:")}</p>
                        <button className="ai-cta" onClick={() => setShowSettings(true)}>
                          {T("⚙ 填写 API 地址 + 令牌", "⚙ Set API URL + key")}
                        </button>
                      </>
                    ) : (
                      <>
                        <p>{T("问我任何关于你邮箱的事，我会直接帮你读、搜、发。", "Ask anything about your mail — I can read, search and send for you.")}</p>
                        <div className="ai-suggest">
                          {suggestions.map((s) => (
                            <button key={s} onClick={() => { setInput(s); inputRef.current?.focus(); }}>{s}</button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`ai-msg ${m.role}`}>
                    <div className="ai-bubble">{m.content}</div>
                    {m.trace && m.trace.length > 0 && (
                      <div className="ai-actions">
                        {m.trace.map((t, j) => {
                          const meta = TOOL_META[t.name] ?? { icon: "•", danger: false };
                          return (
                            <div key={j} className={`ai-action-card ${t.ok ? "ok" : "fail"}`}>
                              <span className="ai-action-icon">{meta.icon}</span>
                              <div className="ai-action-body">
                                <div className="ai-action-desc">{describeTool(t, lang === "zh")}</div>
                                <div className="ai-action-result">{resultSummary(t, lang === "zh")}</div>
                              </div>
                              <span className={`ai-action-status ${t.ok ? "ok" : "fail"}`}>{t.ok ? "✓" : "!"}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
                {pendingPlan && (
                  <div className="ai-confirm">
                    <div className="ai-confirm-title">{T("确认执行以下操作？", "Confirm these actions?")}</div>
                    {pendingPlan.plan.map((p, i) => {
                      const meta = TOOL_META[p.name] ?? { icon: "⚠", danger: true };
                      return (
                        <div key={i} className="ai-action-card danger">
                          <span className="ai-action-icon">{meta.icon}</span>
                          <div className="ai-action-body">
                            <div className="ai-action-desc">{describeTool({ ...p, ok: true }, lang === "zh")}</div>
                          </div>
                        </div>
                      );
                    })}
                    {pendingPlan.plan[0]?.args?.body && (
                      <pre className="ai-confirm-body">{String(pendingPlan.plan[0].args.body).slice(0, 600)}</pre>
                    )}
                    {pendingPlan.plan.some((p) => p.name === "send_mail" || p.name === "reply_mail") && (
                      <div className="ai-confirm-warn">{T("⚠ 邮件发出后不可撤销", "⚠ Sending cannot be undone")}</div>
                    )}
                    <div className="ai-confirm-actions">
                      <button className="ai-btn-ghost" onClick={() => setPendingPlan(null)} disabled={busy}>{T("取消", "Cancel")}</button>
                      <button className="ai-btn-primary" onClick={() => void handleConfirm()} disabled={busy}>{T("确认执行", "Confirm")}</button>
                    </div>
                  </div>
                )}
                {busy && (
                  <div className="ai-msg assistant">
                    <div className="ai-bubble ai-typing"><span /><span /><span /></div>
                  </div>
                )}
                {error && !busy && <div className="ai-err ai-err-inline">{error}</div>}
              </div>
              {undoStack.length > 0 && (
                <button className="ai-undo-bar" onClick={() => void handleUndo()} disabled={busy}>
                  ↩ {T(`撤销上一步：${undoStack[undoStack.length - 1].label_zh}`, `Undo: ${undoStack[undoStack.length - 1].label_en}`)}
                </button>
              )}

              <div className="ai-input">
                <textarea
                  ref={inputRef}
                  value={input}
                  rows={1}
                  placeholder={config?.configured ? T("发消息…", "Message…") : T("先去设置里配置模型端点", "Configure a model endpoint first")}
                  disabled={!config?.configured || busy}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSend();
                    }
                  }}
                />
                <button className="ai-send" onClick={() => void handleSend()} disabled={!config?.configured || busy || !input.trim()} aria-label={T("发送", "Send")}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></svg>
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
