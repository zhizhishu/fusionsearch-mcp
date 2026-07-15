import { useEffect, useRef, useState, type ReactNode } from "react";
import { sendMail, replyMail, type MailDetail } from "../api";
import { usePrefs } from "../i18n";

type Mode = "text" | "rich" | "html";

type Props = {
  open: boolean;
  fromMailbox: string;
  reply?: MailDetail | null; // 传入则进入“回复”模式（自动引用原文 + 走线程回复接口）
  onClose: () => void;
  onSent: (msg: string) => void;
  onError: (msg: string) => void;
};

const splitRecipients = (v: string) => v.split(/[,\n;]/).map((s) => s.trim()).filter(Boolean);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const stripHtml = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// 16px 线性 SVG 图标（替掉廉价感的 emoji，单色走 currentColor）
const svg = (path: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">{path}</svg>
);
const Ico = {
  link: svg(<><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>),
  image: svg(<><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" /></>),
  upload: svg(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></>),
  eye: svg(<><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>)
};

export function ComposeCard({ open, fromMailbox, reply, onClose, onSent, onError }: Props) {
  const { lang } = usePrefs();
  const L = (zh: string, en: string) => (lang === "zh" ? zh : en);

  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [mode, setMode] = useState<Mode>("text");
  const [body, setBody] = useState("");       // text / html 源
  const [richHtml, setRichHtml] = useState(""); // 富文本 innerHTML
  const [replyAll, setReplyAll] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const richRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 打开时初始化；回复模式自动引用原文（像 Gmail 应用上文）
  useEffect(() => {
    if (!open) return;
    if (reply) {
      setTo(reply.source || "");
      setSubject(/^re:/i.test(reply.subject || "") ? reply.subject || "" : `Re: ${reply.subject || ""}`);
      const when = reply.received_at || reply.created_at || "";
      const origText = reply.text || stripHtml(reply.html || "");
      const quoted =
        `<p><br></p><div style="color:#888;font-size:13px">${L("在", "On")} ${esc(when)}，${esc(reply.source || "")} ${L("写道：", "wrote:")}</div>` +
        `<blockquote style="margin:6px 0 0;padding-left:12px;border-left:2px solid #ccc;color:#666">` +
        `${reply.html || esc(origText).replace(/\n/g, "<br>")}</blockquote>`;
      setMode("rich");
      setRichHtml(quoted);
      setBody(`\n\n${L("在", "On")} ${when}，${reply.source || ""} ${L("写道：", "wrote:")}\n` + origText.split("\n").map((l) => "> " + l).join("\n"));
    } else {
      setTo(""); setSubject(""); setMode("text"); setBody(""); setRichHtml("");
    }
    setCc(""); setBcc(""); setShowCcBcc(false); setReplyAll(false); setPreview(false); setBusy(false);
  }, [open, reply]);

  // 切到富文本时把内容灌进 contentEditable
  useEffect(() => {
    if (open && mode === "rich" && !preview && richRef.current && richRef.current.innerHTML !== richHtml) {
      richRef.current.innerHTML = richHtml;
    }
  }, [open, mode, preview]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function switchMode(m: Mode) {
    if (m === mode) return;
    if (mode === "rich") {
      const h = richRef.current?.innerHTML ?? richHtml;
      setRichHtml(h);
      setBody(h); // 富文本 → 文本/HTML：保留 HTML 源
    } else if (m === "rich") {
      setRichHtml(body || "");
    }
    setMode(m);
  }

  function exec(cmd: string, val?: string) {
    richRef.current?.focus();
    document.execCommand(cmd, false, val);
    setRichHtml(richRef.current?.innerHTML ?? "");
  }
  function insertImg(src: string) {
    const tag = `<img src="${src}" style="max-width:100%" alt="" />`;
    if (mode === "rich") {
      exec("insertHTML", tag);
    } else {
      setBody((b) => (b ? b + "\n" : "") + tag);
      if (mode === "text") setMode("html");
    }
  }
  function linkImage() {
    const url = prompt(L("图片链接 URL：", "Image URL:"));
    if (url && url.trim()) insertImg(url.trim());
  }
  function uploadImage(file: File) {
    if (!file.type.startsWith("image/")) { onError(L("请选图片文件", "Pick an image file")); return; }
    if (file.size > 1.5 * 1024 * 1024) { onError(L("图片过大(>1.5MB)，建议改用「链接图片」", "Image too big (>1.5MB), use Link image instead")); return; }
    const r = new FileReader();
    r.onload = () => { if (typeof r.result === "string") insertImg(r.result); };
    r.onerror = () => onError(L("读取图片失败", "Failed to read image"));
    r.readAsDataURL(file);
  }

  function currentBody(): { content: string; html: boolean } {
    if (mode === "rich") return { content: richRef.current?.innerHTML ?? richHtml, html: true };
    if (mode === "html") return { content: body, html: true };
    return { content: body, html: false };
  }

  async function handleSend() {
    const { content, html } = currentBody();
    setBusy(true);
    try {
      if (reply) {
        await replyMail({ mailId: reply.id, body: content, html, toAll: replyAll });
        onSent(L("回复已发送", "Reply sent"));
      } else {
        const toList = splitRecipients(to);
        if (!fromMailbox || toList.length === 0) { setBusy(false); return; }
        await sendMail({
          from: fromMailbox,
          to: toList,
          cc: cc ? splitRecipients(cc) : undefined,
          bcc: bcc ? splitRecipients(bcc) : undefined,
          subject: subject || undefined,
          body: content || undefined,
          html
        });
        onSent(L("邮件已发送", "Mail sent"));
      }
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const canSend = reply ? true : Boolean(fromMailbox) && splitRecipients(to).length > 0;
  const { content: pvContent, html: pvHtml } = currentBody();
  const previewSrc = pvHtml ? pvContent : `<pre style="white-space:pre-wrap;font-family:ui-sans-serif,system-ui;font-size:14px;color:#111">${esc(pvContent)}</pre>`;

  return (
    <div className="compose-overlay" onClick={onClose}>
      <div className="compose-card" role="dialog" aria-label={reply ? L("回复", "Reply") : L("写邮件", "Compose")} onClick={(e) => e.stopPropagation()}>
        <header className="compose-head">
          <h2>{reply ? L("回复", "Reply") : L("写邮件", "Compose")}<span className="dot-accent">.</span></h2>
          <button className="icon-btn" onClick={onClose} aria-label="close">×</button>
        </header>

        <div className="compose-fields">
          <div className="cf-row"><span className="cf-k">{L("发件人", "From")}</span><span className="cf-static">{fromMailbox || "—"}</span></div>
          <div className="cf-row"><span className="cf-k">{L("收件人", "To")}</span>
            {reply
              ? <span className="cf-static">{to || "—"}</span>
              : <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="alice@example.com, bob@example.com" />}
            {!reply && <button className="mini-link cf-ccbtn" onClick={() => setShowCcBcc((s) => !s)}>{showCcBcc ? L("收起", "hide") : L("抄送/密送", "cc/bcc")}</button>}
          </div>
          {!reply && showCcBcc && (
            <>
              <div className="cf-row"><span className="cf-k">{L("抄送", "Cc")}</span><input value={cc} onChange={(e) => setCc(e.target.value)} placeholder={L("可选", "optional")} /></div>
              <div className="cf-row"><span className="cf-k">{L("密送", "Bcc")}</span><input value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder={L("可选", "optional")} /></div>
            </>
          )}
          <div className="cf-row"><span className="cf-k">{L("主题", "Subject")}</span><input className="cf-subj" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={L("主题", "Subject")} /></div>
          {reply && <label className="cf-replyall"><input type="checkbox" checked={replyAll} onChange={(e) => setReplyAll(e.target.checked)} />{L("回复全部", "Reply all")}</label>}
        </div>

        <div className="compose-toolbar">
          <div className="seg">
            {(["text", "rich", "html"] as Mode[]).map((m) => (
              <button key={m} className={mode === m ? "on" : ""} onClick={() => switchMode(m)}>
                {m === "text" ? L("纯文本", "Text") : m === "rich" ? L("富文本", "Rich") : "HTML"}
              </button>
            ))}
          </div>
          {mode === "rich" && !preview && (
            <>
              <span className="tb-div" />
              <div className="rt-tools">
                <button className="tb-btn tb-glyph" onMouseDown={(e) => { e.preventDefault(); exec("bold"); }} title={L("加粗", "Bold")}><b>B</b></button>
                <button className="tb-btn tb-glyph" onMouseDown={(e) => { e.preventDefault(); exec("italic"); }} title={L("斜体", "Italic")}><i>I</i></button>
                <button className="tb-btn" onMouseDown={(e) => { e.preventDefault(); const u = prompt(L("链接 URL：", "Link URL:")); if (u) exec("createLink", u); }} title={L("链接", "Link")}>{Ico.link}</button>
              </div>
            </>
          )}
          <span className="tb-spacer" />
          <button className="tb-btn" onClick={linkImage} title={L("插入图片链接", "Image by URL")}>{Ico.image}</button>
          <button className="tb-btn" onClick={() => fileRef.current?.click()} title={L("上传图片", "Upload image")}>{Ico.upload}</button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f); e.target.value = ""; }} />
          <span className="tb-div" />
          <button className={`tb-btn ${preview ? "on" : ""}`} onClick={() => setPreview((p) => !p)} title={L("预览", "Preview")}>{Ico.eye}</button>
        </div>

        <div className={`compose-body ${preview ? "is-preview" : ""}`}>
          {preview ? (
            <iframe className="compose-preview" title="preview" sandbox="" srcDoc={previewSrc} />
          ) : mode === "rich" ? (
            <div ref={richRef} className="rt-area" data-placeholder={L("正文…", "Body…")} contentEditable suppressContentEditableWarning onInput={() => setRichHtml(richRef.current?.innerHTML ?? "")} />
          ) : (
            <textarea className="compose-text" value={body} onChange={(e) => setBody(e.target.value)} placeholder={mode === "html" ? L("HTML 源码…", "HTML source…") : L("正文…", "Body…")} />
          )}
        </div>

        <footer className="compose-foot">
          <button className="ghost" onClick={onClose} disabled={busy}>{L("取消", "Cancel")}</button>
          <button className="primary" onClick={handleSend} disabled={busy || !canSend}>{busy ? L("发送中…", "Sending…") : L("发送", "Send")}</button>
        </footer>
      </div>
    </div>
  );
}
