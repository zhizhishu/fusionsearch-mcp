import { useEffect, useMemo, useState } from "react";
import { CommunicationRulesDrawer } from "./components/CommunicationRulesDrawer";
import { ComposeCard } from "./components/ComposeCard";
import { InboxView } from "./components/InboxView";
import { ListenersDrawer } from "./components/ListenersDrawer";
import { MailboxesView } from "./components/MailboxesView";
import { CfMailView } from "./components/CfMailView";
import { SettingsView } from "./components/SettingsView";
import { AiBubble } from "./components/AiBubble";
import { DocsModal } from "./components/DocsModal";
import { SentView } from "./components/SentView";
import { ProviderManageCard } from "./components/ProviderManageCard";
import { useResizableWidth } from "./hooks";
import { PrefsBar, usePrefs } from "./i18n";
import {
  createEventSource,
  createMailbox,
  deleteMailbox,
  disconnectClaw,
  fetchClawAuthStatus,
  fetchListeners,
  fetchMail,
  fetchCfAliases,
  fetchCfProviders,
  addCfProvider,
  updateCfProvider,
  deleteCfProvider,
  fetchMailboxes,
  fetchMails,
  getAdminPassword,
  getRuntimeMode,
  refreshClawConnection,
  sendClawLoginCode,
  setAdminPassword,
  setRuntimeMode,
  verifyAdminPassword,
  verifyClawLoginCode,
  type CfAlias,
  type TempProviderPublic,
  type ClawAuthStatus,
  type ListenerSnapshot,
  type MailDetail,
  type MailSummary,
  type Mailbox
} from "./api";

type View = "mailboxes" | "inbox" | "sent" | "cf" | "settings";
const VIEW_STORAGE_KEY = "claw.currentView";

const VIEW_KEYS: Record<"mailboxes" | "inbox" | "sent" | "cf", { eyebrow: string; title: string; subtitle: string }> = {
  mailboxes: {
    eyebrow: "view.mailboxes.eyebrow",
    title: "view.mailboxes.title",
    subtitle: "view.mailboxes.subtitle"
  },
  inbox: {
    eyebrow: "view.inbox.eyebrow",
    title: "view.inbox.title",
    subtitle: "view.inbox.subtitle"
  },
  sent: {
    eyebrow: "view.sent.eyebrow",
    title: "view.sent.title",
    subtitle: "view.sent.subtitle"
  },
  cf: {
    eyebrow: "view.cf.eyebrow",
    title: "view.cf.title",
    subtitle: "view.cf.subtitle"
  }
};

const LIVE_LISTENER_STATUSES = new Set(["running", "open"]);

function readInitialView(): View {
  if (typeof localStorage === "undefined") return "mailboxes";
  const saved = localStorage.getItem(VIEW_STORAGE_KEY);
  return saved === "inbox" || saved === "mailboxes" ? saved : "mailboxes";
}

export function App() {
  const { t, lang } = usePrefs();

  const initialAdminPassword = getAdminPassword();
  const [password, setPassword] = useState("");
  const [loginInput, setLoginInput] = useState(initialAdminPassword);
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(Boolean(initialAdminPassword));

  const [view, setView] = useState<View>(readInitialView);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [selectedMailbox, setSelectedMailbox] = useState("");
  const [mails, setMails] = useState<MailSummary[]>([]);
  const [selectedMail, setSelectedMail] = useState<MailDetail | null>(null);

  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const [suffix, setSuffix] = useState("");
  const [mailboxSyncBusy, setMailboxSyncBusy] = useState(false);
  const [rulesMailbox, setRulesMailbox] = useState<Mailbox | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<MailDetail | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);

  const [clawAuth, setClawAuth] = useState<ClawAuthStatus | null>(null);
  const [clawLoginEmail, setClawLoginEmail] = useState("");
  const [clawLoginCode, setClawLoginCode] = useState("");
  const [clawCodeSent, setClawCodeSent] = useState(false);
  const [clawBusy, setClawBusy] = useState(false);
  const [connectionDetailsOpen, setConnectionDetailsOpen] = useState(false);
  const [connCardOpen, setConnCardOpen] = useState(false);
  const [cfAliasesByProvider, setCfAliasesByProvider] = useState<Record<string, CfAlias[]>>({});
  const [tempProviders, setTempProviders] = useState<TempProviderPublic[]>([]);
  const [cfProvider, setCfProvider] = useState<string | undefined>(undefined);
  const [cfFocusAlias, setCfFocusAlias] = useState<string | undefined>(undefined);
  const [clawGroupOpen, setClawGroupOpen] = useState(true);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [mailboxQuery, setMailboxQuery] = useState("");
  const [mailboxCat, setMailboxCat] = useState<string>("claw");

  const [listenerItems, setListenerItems] = useState<ListenerSnapshot[]>([]);
  const [listenerBusy, setListenerBusy] = useState(false);
  const [listenersDrawerOpen, setListenersDrawerOpen] = useState(false);

  const rail = useResizableWidth({
    storageKey: "rail.width",
    initial: 280,
    min: 220,
    max: 480
  });

  const activeMailboxes = useMemo(
    () => mailboxes.filter((mailbox) => mailbox.status !== "deleted"),
    [mailboxes]
  );

  const listenerSummary = useMemo(() => {
    let running = 0;
    let errors = 0;
    for (const item of listenerItems) {
      if (LIVE_LISTENER_STATUSES.has(item.status)) running++;
      if (item.status === "error" || item.error) errors++;
    }
    return { running, total: listenerItems.length, errors };
  }, [listenerItems]);

  function reportError(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
  }

  function formatLoginError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    return message === "unauthorized" ? t("login.error.unauthorized") : message;
  }

  async function handleLogin(nextPassword = loginInput) {
    if (!nextPassword) return;
    setLoginBusy(true);
    setLoginError("");
    try {
      const data = await verifyAdminPassword(nextPassword);
      setAdminPassword(nextPassword);
      setPassword(nextPassword);
      setClawAuth(data);
      setError("");
    } catch (err) {
      const loginMessage = formatLoginError(err);
      setAdminPassword("");
      setPassword("");
      setLoginError(loginMessage);
      if (loginMessage === t("login.error.unauthorized")) {
        setLoginInput("");
      }
    } finally {
      setLoginBusy(false);
    }
  }

  useEffect(() => {
    const savedPassword = getAdminPassword();
    if (!savedPassword) return;
    handleLogin(savedPassword);
  }, []);

  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  }, [view]);

  async function loadMailboxes(sync = false): Promise<Mailbox[]> {
    setError("");
    const items = await fetchMailboxes(sync);
    setMailboxes(items);
    return items;
  }

  async function loadClawAuthStatus() {
    const data = await fetchClawAuthStatus();
    setClawAuth(data);
  }

  async function loadMails(mailbox = selectedMailbox, sync = false) {
    setError("");
    const data = await fetchMails(mailbox || undefined, 50, 0, sync);
    setMails(data.items);
    if (selectedMail && !data.items.some((mail) => mail.id === selectedMail.id)) {
      setSelectedMail(null);
    }
  }

  async function loadMail(id: number) {
    setError("");
    const detail = await fetchMail(id);
    setSelectedMail(detail);
  }

  async function loadListeners() {
    setListenerBusy(true);
    try {
      const data = await fetchListeners();
      setListenerItems(data);
    } catch (err) {
      reportError(err);
    } finally {
      setListenerBusy(false);
    }
  }

  useEffect(() => {
    if (!password) return;
    setAdminPassword(password);
    loadClawAuthStatus().catch(reportError);
    loadMailboxes().catch(reportError);
    fetchCfProviders().then(setTempProviders).catch(() => setTempProviders([]));
  }, [password]);

  // load each temp source's aliases into a per-provider map (for the sidebar groups)
  useEffect(() => {
    let alive = true;
    Promise.all(
      tempProviders.map((p) =>
        fetchCfAliases(p.id)
          .then((a) => [p.id, a] as const)
          .catch(() => [p.id, [] as CfAlias[]] as const)
      )
    ).then((entries) => {
      if (alive) setCfAliasesByProvider(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
  }, [tempProviders]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => {
      setStatus("");
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (!password) return;
    if (getRuntimeMode() === "cloudflare") return;
    const events = createEventSource();
    events.addEventListener("mail", () => {
      loadMails().catch(reportError);
    });
    events.addEventListener("cloudflare-mode", () => {
      setRuntimeMode("cloudflare");
      events.close();
      setStatus(t("flash.events.manualSync"));
    });
    events.onerror = () => {
      if (getRuntimeMode() === "cloudflare") return;
      setStatus(t("flash.events.reconnecting"));
    };
    return () => events.close();
  }, [password, selectedMailbox]);

  useEffect(() => {
    if (!password) return;
    setSelectedMail(null);
    loadMails(selectedMailbox, true).catch(reportError);
  }, [password, selectedMailbox]);

  // Auto-fetch listener summary once Claw is connected, and again on demand
  // when the connection details panel is opened.
  useEffect(() => {
    if (!password) return;
    if (!clawAuth?.connected) {
      setListenerItems([]);
      return;
    }
    loadListeners();
  }, [password, clawAuth?.connected]);

  useEffect(() => {
    if (!connectionDetailsOpen) return;
    if (!clawAuth?.connected) return;
    loadListeners();
  }, [connectionDetailsOpen]);

  async function handleCreateMailbox() {
    setStatus(""); setError("");
    try {
      const created = await createMailbox(suffix);
      setSuffix("");
      setStatus(t("flash.mb.created", { email: created.email }));
      await loadMailboxes();
    } catch (err) {
      reportError(err);
    }
  }

  async function handleDeleteMailbox(mailbox: Mailbox) {
    if (!confirm(t("mb.confirm.delete", { email: mailbox.email }))) return;
    setStatus(""); setError("");
    try {
      await deleteMailbox(mailbox.id);
      setStatus(t("flash.mb.deleted", { email: mailbox.email }));
      await loadMailboxes();
      if (selectedMailbox === mailbox.email) {
        setSelectedMailbox("");
        setMails([]);
      }
    } catch (err) {
      reportError(err);
    }
  }

  function reloadCfAliases() {
    Promise.all(
      tempProviders.map((p) =>
        fetchCfAliases(p.id)
          .then((a) => [p.id, a] as const)
          .catch(() => [p.id, [] as CfAlias[]] as const)
      )
    )
      .then((entries) => setCfAliasesByProvider(Object.fromEntries(entries)))
      .catch(() => {});
  }

  async function handleAddTempProvider(input: {
    name: string;
    type: "php" | "cf";
    endpoint: string;
    domain: string;
    password: string;
  }) {
    setStatus(""); setError("");
    try {
      const created = await addCfProvider(input);
      setStatus(lang === "zh" ? `已添加临时邮箱源 ${created.name}` : `added temp source ${created.name}`);
      setTempProviders(await fetchCfProviders());
      setMailboxCat(created.id);
      reloadCfAliases();
    } catch (err) {
      reportError(err);
    }
  }

  async function handleUpdateTempProvider(
    id: string,
    patch: { name?: string; type?: "php" | "cf"; endpoint?: string; domain?: string; password?: string }
  ) {
    setStatus(""); setError("");
    try {
      await updateCfProvider(id, patch);
      setStatus(lang === "zh" ? "已更新源" : "source updated");
      setTempProviders(await fetchCfProviders());
    } catch (err) {
      reportError(err);
    }
  }

  async function handleDeleteTempProvider(id: string) {
    if (!confirm(lang === "zh" ? `删除临时邮箱源 ${id}？` : `Delete temp source ${id}?`)) return;
    setStatus(""); setError("");
    try {
      await deleteCfProvider(id);
      setStatus(lang === "zh" ? "已删除" : "deleted");
      setTempProviders(await fetchCfProviders());
    } catch (err) {
      reportError(err);
    }
  }

  async function handleSendClawCode() {
    setStatus(""); setError(""); setClawBusy(true);
    try {
      await sendClawLoginCode(clawLoginEmail.trim());
      setClawCodeSent(true);
      setStatus(t("flash.code.sent"));
    } catch (err) {
      reportError(err);
    } finally {
      setClawBusy(false);
    }
  }

  async function handleVerifyClawCode() {
    setStatus(""); setError(""); setClawBusy(true);
    try {
      const result = await verifyClawLoginCode(clawLoginEmail.trim(), clawLoginCode.trim());
      setClawAuth(result.auth);
      setClawLoginCode("");
      setClawCodeSent(false);
      setStatus(t("flash.claw.bound", { n: result.syncedMailboxes }));
      await loadMailboxes();
    } catch (err) {
      reportError(err);
    } finally {
      setClawBusy(false);
    }
  }

  async function handleRefreshClaw() {
    setStatus(""); setError(""); setClawBusy(true);
    try {
      const result = await refreshClawConnection();
      setClawAuth(result.auth);
      setStatus(t("flash.claw.refreshed", { n: result.syncedMailboxes }));
      await loadMailboxes();
      loadListeners();
    } catch (err) {
      reportError(err);
    } finally {
      setClawBusy(false);
    }
  }

  async function handleSyncMailboxes() {
    setStatus(t("flash.mb.syncing"));
    setError("");
    setMailboxSyncBusy(true);
    try {
      const items = await loadMailboxes(true);
      setStatus(t("flash.mb.synced", {
        n: items.filter((mailbox) => mailbox.status !== "deleted").length
      }));
      loadListeners();
    } catch (err) {
      reportError(err);
    } finally {
      setMailboxSyncBusy(false);
    }
  }

  async function handleDisconnectClaw() {
    if (!confirm(t("confirm.disconnect"))) return;
    setStatus(""); setError(""); setClawBusy(true);
    try {
      const result = await disconnectClaw();
      setClawAuth(result);
      setConnectionDetailsOpen(false);
      setListenerItems([]);
      setStatus(t("flash.claw.severed"));
    } catch (err) {
      reportError(err);
    } finally {
      setClawBusy(false);
    }
  }

  function handleLogout() {
    setAdminPassword("");
    setPassword("");
    setLoginInput("");
    setLoginError("");
    setClawAuth(null);
    setConnectionDetailsOpen(false);
    setListenerItems([]);
    setListenersDrawerOpen(false);
    setRulesMailbox(null);
    setMailboxes([]);
    setSelectedMailbox("");
    setMails([]);
    setSelectedMail(null);
    setStatus("");
    setError("");
  }

  // ---------- LOGIN ----------

  if (!password) {
    const stamp = new Date()
      .toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false })
      .slice(0, 19);
    return (
      <main className="login-cover">
        <nav className="lc-nav">
          <div className="lc-nav-inner">
            <span className="lc-brand">claw<span className="dot">.</span></span>
            <PrefsBar variant="login" />
          </div>
        </nav>

        <div className="lc-main">
          <div className="lc-glow" aria-hidden="true" />
          <div className="lc-blobs" aria-hidden="true">
            <span className="blob blob-blue" />
            <span className="blob blob-pink" />
            <span className="blob blob-green" />
            <span className="blob blob-purple" />
          </div>

          <section className="lc-hero">
            <span className="lc-badge">{lang === "zh" ? "✦ 子邮箱 · 临时邮箱 · 一站收发" : "✦ Sub-mailbox · Temp mail · One console"}</span>
            <h1>
              {t("login.headline.1")} {t("login.headline.2")}
              <span className="lc-primary">{t("login.headline.3")}</span>
            </h1>
            <p>{t("login.pitch")}</p>
            <div className="lc-enter">
              <input
                type="password"
                autoFocus
                value={loginInput}
                placeholder={t("login.placeholder.password")}
                disabled={loginBusy}
                onChange={(event) => {
                  setLoginInput(event.target.value);
                  setLoginError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleLogin();
                }}
              />
              <button className="lc-btn-primary" onClick={() => handleLogin()} disabled={loginBusy || !loginInput}>
                {loginBusy ? t("login.btn.verifying") : t("login.btn.enter")}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m4 17 6-6-6-6" />
                  <path d="M12 19h8" />
                </svg>
              </button>
            </div>
            {loginError && <div className="err lc-err">{loginError}</div>}
          </section>

          <section className="lc-showcase" aria-hidden="true">
            <div className="lc-console">
              <aside className="lc-side">
                <div className="lc-side-brand">claw<span className="dot">.</span></div>
                <div className="lc-side-nav">
                  <div className="lc-nav-item on">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
                    <span>{lang === "zh" ? "收件箱" : "Inbox"}</span>
                  </div>
                  <div className="lc-nav-item">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" /></svg>
                    <span>{lang === "zh" ? "别名" : "Aliases"}</span>
                  </div>
                  <div className="lc-nav-item">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="8" rx="2" /><rect x="2" y="13" width="20" height="8" rx="2" /><path d="M6 7h.01M6 17h.01" /></svg>
                    <span>{lang === "zh" ? "临时邮箱" : "Temp mail"}</span>
                  </div>
                  <div className="lc-nav-item">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></svg>
                    <span>{lang === "zh" ? "终端" : "Console"}</span>
                  </div>
                </div>
                <div className="lc-conn"><span className="lc-dot" /> connected</div>
              </aside>

              <div className="lc-mid">
                <div className="lc-mid-head"><span>{lang === "zh" ? "收件" : "Incoming"}</span></div>
                <div className="lc-mail on">
                  <div className="lc-mail-top"><span className="lc-from">github.com</span><span className="lc-time">2m</span></div>
                  <div className="lc-subj">{lang === "zh" ? "验证你的登录" : "Verify your sign-in"}</div>
                  <div className="lc-prev">{lang === "zh" ? "点击下方链接完成验证…" : "Click the link below to continue…"}</div>
                </div>
                <div className="lc-mail">
                  <div className="lc-mail-top"><span className="lc-from">vercel.app</span><span className="lc-time">14m</span></div>
                  <div className="lc-subj">{lang === "zh" ? "部署成功" : "Deployment succeeded"}</div>
                  <div className="lc-prev">{lang === "zh" ? "你的项目已经上线…" : "Your project is now live…"}</div>
                </div>
                <div className="lc-mail">
                  <div className="lc-mail-top"><span className="lc-from">edu.002836.xyz</span><span className="lc-time">1h</span></div>
                  <div className="lc-subj">{lang === "zh" ? "临时验证码" : "Temporary code"}</div>
                  <div className="lc-prev">{lang === "zh" ? "你的验证码是 482913…" : "Your verification code is 482913…"}</div>
                </div>
              </div>

              <div className="lc-detail">
                <div className="lc-det-head">
                  <span className="mono" style={{ fontSize: 12, opacity: 0.6 }}>#33</span>
                  <button className="lc-copy">{lang === "zh" ? "复制链接" : "Copy link"}</button>
                </div>
                <div className="lc-det-body">
                  <h2>{lang === "zh" ? "验证你的登录" : "Verify your sign-in"}</h2>
                  <div className="lc-det-from">noreply@github.com</div>
                  <div className="lc-det-card">
                    <p>{lang === "zh" ? "你好，" : "Hey there,"}</p>
                    <p>{lang === "zh" ? "我们检测到一次新的登录。点击下方按钮确认是你本人。" : "We detected a new sign-in. Confirm it was you with the button below."}</p>
                    <div className="lc-verify">{lang === "zh" ? "确认登录" : "VERIFY SIGN-IN"}</div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="lc-features">
            <div className="lc-feat">
              <div className="lc-feat-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 3h5v5" /><path d="M4 20 21 3" /><path d="M21 16v5h-5" /><path d="m15 15 6 6" /><path d="M4 4l5 5" /></svg>
              </div>
              <h3>{lang === "zh" ? "无限别名" : "Infinite aliases"}</h3>
              <p>{lang === "zh" ? "为每个服务一键创建子邮箱与临时别名，主收件箱保持干净安全。" : "Forge a sub-mailbox or temp alias for every service in one click. Keep your primary inbox clean."}</p>
            </div>
            <div className="lc-feat">
              <div className="lc-feat-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></svg>
              </div>
              <h3>{lang === "zh" ? "统一控制台" : "One console"}</h3>
              <p>{lang === "zh" ? "子邮箱与临时邮箱，一个面板统一收发管理。" : "Sub-mailboxes and temp mail, managed from one unified console."}</p>
            </div>
            <div className="lc-feat">
              <div className="lc-feat-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
              </div>
              <h3>{lang === "zh" ? "数据沉淀" : "Durable storage"}</h3>
              <p>{lang === "zh" ? "数据持久化到 Supabase，重启不丢，开发够用、说删就删。" : "Persisted to Supabase, survives restarts. Durable for dev work, disposable on demand."}</p>
            </div>
          </section>

          <section className="lc-cta">
            <div className="lc-cta-card">
              <div className="lc-cta-glow" aria-hidden="true" />
              <h2>{lang === "zh" ? "准备好接管你的收件箱了吗？" : "Ready to take command of your inbox?"}</h2>
              <p>{lang === "zh" ? "输入管理员密码，进入这个安静而精密的邮箱控制台。" : "Enter the admin password to step into a quiet, precise mail console."}</p>
              <button className="lc-btn-primary" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
                {lang === "zh" ? "进入控制台" : "Enter console"}
              </button>
            </div>
          </section>
        </div>

        <footer className="lc-foot">
          <div className="lc-foot-inner">
            <div>
              <div className="lc-foot-brand">claw<span className="dot">.</span></div>
              <p className="lc-foot-copy">{lang === "zh" ? "精密收件箱管理。" : "Precision inbox management."}</p>
              <div className="lc-foot-tags">
                <span>子邮箱</span>
                <span>临时邮箱</span>
              </div>
            </div>
            <div>
              <h4>{lang === "zh" ? "产品" : "Product"}</h4>
              <ul>
                <li><a>{lang === "zh" ? "收件箱" : "Inbox"}</a></li>
                <li><a>{lang === "zh" ? "邮箱" : "Mailboxes"}</a></li>
                <li><a>{lang === "zh" ? "临时邮箱" : "Temp mail"}</a></li>
              </ul>
            </div>
            <div>
              <h4>{lang === "zh" ? "来源" : "Providers"}</h4>
              <ul>
                <li><a>{lang === "zh" ? "子邮箱" : "Sub-mailboxes"}</a></li>
                <li><a>{lang === "zh" ? "临时邮箱" : "Temp mail"}</a></li>
              </ul>
            </div>
            <div>
              <h4>{lang === "zh" ? "项目" : "Project"}</h4>
              <ul>
                <li><a href="https://github.com/zhizhishu/ClawEmail" target="_blank" rel="noreferrer">GitHub</a></li>
                <li><a href="https://huggingface.co/spaces/Echocq/clawemail" target="_blank" rel="noreferrer">HuggingFace</a></li>
              </ul>
            </div>
          </div>
        </footer>
      </main>
    );
  }

  // ---------- MAIN SHELL ----------

  const meta = view === "settings"
    ? {
        eyebrow: lang === "zh" ? "配置" : "CONFIG",
        title: lang === "zh" ? "设置" : "Settings",
        subtitle: lang === "zh" ? "对外出口 · 凭据 · 访问控制 · AI 助手" : "Egress · credentials · access · AI"
      }
    : {
        eyebrow: t(VIEW_KEYS[view].eyebrow),
        title: t(VIEW_KEYS[view].title),
        subtitle: t(VIEW_KEYS[view].subtitle)
      };
  const summaryHasErrors = listenerSummary.errors > 0;
  const summaryAllLive =
    listenerSummary.total > 0 && listenerSummary.running === listenerSummary.total;

  return (
    <main
      className="app-shell"
      style={{ ["--rail-width" as string]: `${rail.width}px` }}
    >
      <aside className="rail">
        <div
          className={`rail-resizer ${rail.dragging ? "dragging" : ""}`}
          onPointerDown={rail.onPointerDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="resize sidebar"
        />
        <div className="brand">
          <span className="word">claw<span style={{ color: "var(--accent-fg)" }}>.</span></span>
          <span className="ver">{t("rail.brand.suffix")}</span>
        </div>

        <nav>
          <div className="eyebrow nav-eyebrow">{t("rail.workspace")}</div>
          <button className={view === "inbox" ? "active" : ""} onClick={() => { setSelectedMailbox(""); setView("inbox"); }}>
            <span className="glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg></span>
            <span>{t("rail.nav.inbox")}</span>
            <span className="count">{mails.length || ""}</span>
          </button>
          <button className={view === "sent" ? "active" : ""} onClick={() => setView("sent")}>
            <span className="glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></svg></span>
            <span>{t("rail.nav.sent")}</span>
          </button>
          <button className={view === "mailboxes" ? "active" : ""} onClick={() => setView("mailboxes")}>
            <span className="glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></svg></span>
            <span>{t("rail.nav.mailboxes")}</span>
            <span className="count">{activeMailboxes.length}</span>
          </button>
          <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
            <span className="glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg></span>
            <span>{lang === "zh" ? "设置" : "Settings"}</span>
            <span className="count">{tempProviders.length || ""}</span>
          </button>
          {(activeMailboxes.length > 0 || tempProviders.length > 0) && (
            <div className="nav-mailboxes">
              <input
                className="nav-mb-search"
                value={mailboxQuery}
                onChange={(event) => setMailboxQuery(event.target.value.toLowerCase())}
                placeholder={lang === "zh" ? "搜索邮箱…" : "Search mailboxes…"}
              />
              {(() => {
                const q = mailboxQuery.trim();
                const claws = activeMailboxes.filter((m) => m.email.split("@")[0].toLowerCase().includes(q));
                return (
                  <>
                    {claws.length > 0 && (
                      <div className="nav-group">
                        <button className="nav-group-head" type="button" onClick={() => setClawGroupOpen((o) => !o)}>
                          <span className="nav-group-chevron">{clawGroupOpen ? "▾" : "▸"}</span>
                          <span className="nav-group-name">Claw</span>
                          <span className="nav-group-count">{claws.length}</span>
                        </button>
                        {clawGroupOpen && claws.map((mailbox) => (
                          <button
                            key={mailbox.id}
                            className={`nav-sub ${view === "inbox" && selectedMailbox === mailbox.email ? "active" : ""}`}
                            onClick={() => { setSelectedMailbox(mailbox.email); setView("inbox"); }}
                            title={mailbox.email}
                          >
                            <span className="nav-sub-dot" />
                            <span className="nav-sub-name">{mailbox.email.split("@")[0]}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {tempProviders.map((p) => {
                      const aliases = (cfAliasesByProvider[p.id] ?? []).filter((a) => a.local.toLowerCase().includes(q));
                      if (q && aliases.length === 0) return null;
                      const open = openGroups[p.id] ?? true;
                      return (
                        <div className="nav-group" key={p.id}>
                          <button
                            className="nav-group-head"
                            type="button"
                            onClick={() => setOpenGroups((g) => ({ ...g, [p.id]: !(g[p.id] ?? true) }))}
                          >
                            <span className="nav-group-chevron">{open ? "▾" : "▸"}</span>
                            <span className="nav-group-name">{p.name}</span>
                            <span className="nav-group-count">{aliases.length}</span>
                          </button>
                          {open &&
                            aliases.map((alias) => (
                              <button
                                key={alias.local}
                                className={`nav-sub ${view === "cf" && cfProvider === p.id && cfFocusAlias === alias.local ? "active" : ""}`}
                                onClick={() => { setCfProvider(p.id); setCfFocusAlias(alias.local); setView("cf"); }}
                                title={alias.address}
                              >
                                <span className="nav-sub-dot edu" />
                                <span className="nav-sub-name">{alias.local}</span>
                              </button>
                            ))}
                        </div>
                      );
                    })}
                  </>
                );
              })()}
            </div>
          )}
        </nav>

        <div className={`conn-card ${clawAuth?.connected ? "connected" : "disconnected"}`}>
          <button
            type="button"
            className="head conn-head-toggle"
            onClick={() => setConnCardOpen((open) => !open)}
            aria-expanded={connCardOpen}
          >
            <strong>{t("conn.title")}</strong>
            <span className="status">
              <span className={`dot ${clawAuth?.connected ? "live" : "warn"}`} />
              {clawAuth?.connected ? t("conn.bound") : t("conn.idle")}
              <span className="conn-chevron">{connCardOpen ? "▾" : "▸"}</span>
            </span>
          </button>
          {connCardOpen && (clawAuth?.connected ? (
            <>
              <div className="actions">
                <button onClick={handleRefreshClaw} disabled={clawBusy}>{t("conn.action.refresh")}</button>
                <button className="danger" onClick={handleDisconnectClaw} disabled={clawBusy}>{t("conn.action.disconnect")}</button>
                <button
                  className="ghost details-toggle"
                  onClick={() => setConnectionDetailsOpen((open) => !open)}
                  aria-expanded={connectionDetailsOpen}
                >
                  {connectionDetailsOpen ? t("conn.action.hideDetails") : t("conn.action.showDetails")}
                </button>
              </div>
              {connectionDetailsOpen && (
                <div className="details">
                  <div className="body">
                    <span className="key">{t("conn.field.user")}</span>
                    <span className="val">{clawAuth.userEmail ?? "—"}</span>
                    <span className="key">{t("conn.field.workspace")}</span>
                    <span className="val">{clawAuth.workspaceName ?? clawAuth.workspaceId}</span>
                    <span className="key">{t("conn.field.root")}</span>
                    <span className="val">
                      {clawAuth.rootPrefix && clawAuth.domain
                        ? `${clawAuth.rootPrefix}@${clawAuth.domain}`
                        : "—"}
                    </span>
                    <span className="key">{t("conn.field.apikey")}</span>
                    <span className="val">{clawAuth.apiKeyPrefix}···{clawAuth.apiKeySuffix}</span>
                  </div>

                  <div className="lis-summary">
                    <div className="lis-summary-row">
                      <span className="lis-label">{t("conn.lis.label")}</span>
                      {listenerSummary.total === 0 && !listenerBusy ? (
                        <span className="lis-empty">{t("conn.lis.empty")}</span>
                      ) : (
                        <span className="lis-stats">
                          <span className={`lis-running ${summaryAllLive ? "ok" : ""}`}>
                            {t("conn.lis.running", {
                              n: listenerSummary.running,
                              total: listenerSummary.total
                            })}
                          </span>
                          <span className="lis-sep">·</span>
                          <span className={`lis-errors ${summaryHasErrors ? "err" : "muted"}`}>
                            {t("conn.lis.errors", { n: listenerSummary.errors })}
                          </span>
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="ghost diag-btn"
                      onClick={() => {
                        setListenersDrawerOpen(true);
                        loadListeners();
                      }}
                    >
                      {t("conn.action.diagnostics")}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="form">
              <input
                type="email"
                value={clawLoginEmail}
                onChange={(event) => setClawLoginEmail(event.target.value)}
                placeholder={t("conn.input.email")}
                disabled={clawBusy}
              />
              {clawCodeSent && (
                <input
                  value={clawLoginCode}
                  onChange={(event) => setClawLoginCode(event.target.value.replace(/\D/g, ""))}
                  placeholder={t("conn.input.code")}
                  disabled={clawBusy}
                />
              )}
              <div className="actions">
                <button onClick={handleSendClawCode} disabled={clawBusy || !clawLoginEmail}>
                  {clawCodeSent ? t("conn.action.resendCode") : t("conn.action.sendCode")}
                </button>
                {clawCodeSent && (
                  <button
                    className="primary"
                    onClick={handleVerifyClawCode}
                    disabled={clawBusy || !clawLoginCode}
                  >
                    {t("conn.action.bind")}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <PrefsBar variant="rail" />

        <div className="footer-row">
          <span>{t("rail.admin")}</span>
          <button className="ghost" onClick={handleLogout}>{t("rail.logout")}</button>
        </div>
      </aside>

      <section className="work">
        <header className="work-head">
          <div className="meta">
            <div className="row">
              <span>{meta.eyebrow}</span>
            </div>
            <h1 className="h-display">
              {meta.title}<span className="pt">.</span>
            </h1>
            <p className="subtitle">{meta.subtitle}</p>
          </div>
          <div className="actions">
            {view === "sent" && (
              <select
                value={selectedMailbox}
                onChange={(event) => setSelectedMailbox(event.target.value)}
              >
                <option value="">{t("toolbar.selectMailbox")}</option>
                {activeMailboxes.map((mailbox) => (
                  <option key={mailbox.id} value={mailbox.email}>{mailbox.email.split("@")[0]}</option>
                ))}
              </select>
            )}
            {view === "mailboxes" && (
              <select
                className="cat-select"
                value={mailboxCat}
                onChange={(event) => setMailboxCat(event.target.value)}
                title={lang === "zh" ? "邮箱大类目" : "Mailbox category"}
              >
                <option value="claw">Claw · {clawAuth?.domain ?? "claw.163.com"}</option>
                {tempProviders.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.domain ? ` · ${p.domain}` : ""}</option>
                ))}
                <option value="__add__">{lang === "zh" ? "＋ 添加源" : "+ Add source"}</option>
              </select>
            )}
            {view === "mailboxes" && mailboxCat === "claw" && (
              <button
                className={`sync-btn ${mailboxSyncBusy ? "syncing" : ""}`}
                onClick={handleSyncMailboxes}
                disabled={!clawAuth?.hasDashboardCookie || mailboxSyncBusy}
                title={t("toolbar.syncHint")}
                aria-busy={mailboxSyncBusy}
              >
                <span className="sync-icon" aria-hidden="true">↻</span>
                <span>{mailboxSyncBusy ? t("toolbar.syncing") : t("toolbar.sync")}</span>
              </button>
            )}
          </div>
        </header>

        <div className="divider-ascii">· · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · ·</div>

        {(status || error) && (
          <div className="flash-line">
            {status && <div className="notice">{status}</div>}
            {error && <div className="err">{error}</div>}
          </div>
        )}

        {view === "mailboxes" && mailboxCat === "claw" && (
          <MailboxesView
            mailboxes={activeMailboxes}
            clawAuth={clawAuth}
            suffix={suffix}
            setSuffix={setSuffix}
            onCreate={handleCreateMailbox}
            onDelete={handleDeleteMailbox}
            onOpen={(mailbox) => {
              setSelectedMailbox(mailbox.email);
              setView("inbox");
            }}
            onConfigureRules={(mailbox) => setRulesMailbox(mailbox)}
          />
        )}

        {view === "mailboxes" && mailboxCat !== "claw" && (
          <ProviderManageCard
            provider={mailboxCat === "__add__" ? undefined : tempProviders.find((p) => p.id === mailboxCat)}
            onAdd={handleAddTempProvider}
            onUpdate={handleUpdateTempProvider}
            onDelete={(id) => { handleDeleteTempProvider(id); setMailboxCat("claw"); }}
            onOpenInbox={(local) => { setCfProvider(mailboxCat); setCfFocusAlias(local); setView("cf"); }}
            onOpenSource={() => { setCfProvider(mailboxCat); setCfFocusAlias(undefined); setView("cf"); }}
            onError={reportError}
            onStatus={setStatus}
            onAliasesChanged={reloadCfAliases}
          />
        )}

        {view === "inbox" && (
          <InboxView
            selectedMailbox={selectedMailbox}
            mails={mails}
            selectedMail={selectedMail}
            onSelectMail={(id) => loadMail(id).catch(reportError)}
            onRefresh={() => loadMails(selectedMailbox, true).catch(reportError)}
            onDeleted={(id, msg) => {
              setMails((items) => items.filter((mail) => mail.id !== id));
              setSelectedMail(null);
              setStatus(msg);
            }}
            onReply={(mail) => setReplyTo(mail)}
            onError={reportError}
            adminPassword={password}
          />
        )}

        {view === "sent" && (
          <SentView
            selectedMailbox={selectedMailbox}
            canCompose={Boolean(selectedMailbox && clawAuth?.hasApiKey)}
            onCompose={() => setComposeOpen(true)}
            onError={reportError}
          />
        )}

        {view === "cf" && (
          <CfMailView onError={reportError} onStatus={(msg) => setStatus(msg)} focusAlias={cfFocusAlias} provider={cfProvider} />
        )}

        {view === "settings" && (
          <SettingsView
            onError={reportError}
            onStatus={(msg) => setStatus(msg)}
          />
        )}
      </section>

      <ComposeCard
        open={composeOpen || Boolean(replyTo)}
        fromMailbox={replyTo ? (replyTo.address || replyTo.mailbox_email) : selectedMailbox}
        reply={replyTo}
        onClose={() => { setComposeOpen(false); setReplyTo(null); }}
        onSent={(msg) => { setStatus(msg); loadMails(selectedMailbox, true).catch(reportError); }}
        onError={reportError}
      />

      <CommunicationRulesDrawer
        open={Boolean(rulesMailbox)}
        mailbox={rulesMailbox}
        onClose={() => setRulesMailbox(null)}
        onSaved={(updated, msg) => {
          setMailboxes((items) => items.map((item) => item.id === updated.id ? updated : item));
          setRulesMailbox(null);
          setStatus(msg);
        }}
        onError={reportError}
      />

      <ListenersDrawer
        open={listenersDrawerOpen}
        busy={listenerBusy}
        items={listenerItems}
        onClose={() => setListenersDrawerOpen(false)}
        onRefresh={loadListeners}
      />

      <button className="docs-fab" title={lang === "zh" ? "API 调用文档" : "API docs"} aria-label="API docs" onClick={() => setDocsOpen(true)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><path d="M13 3v5h5" /><path d="M8 13h8" /><path d="M8 17h6" />
        </svg>
      </button>
      <DocsModal open={docsOpen} onClose={() => setDocsOpen(false)} onError={reportError} onStatus={(m) => setStatus(m)} />

      <AiBubble />
    </main>
  );
}
