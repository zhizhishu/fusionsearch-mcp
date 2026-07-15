import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { config } from "./config";
import "./db";
import { mailboxRoutes } from "./routes/mailboxes";
import { mailRoutes } from "./routes/mails";
import { clawOpsRoutes } from "./routes/claw-ops";
import { sendRoutes } from "./routes/send";
import { eventRoutes } from "./routes/events";
import { clawAuthRoutes } from "./routes/claw-auth";
import { cfMailRoutes } from "./routes/cf-mail";
import { aiRoutes } from "./routes/ai";
import { secretRoutes } from "./routes/secrets";
import { extCfRoutes } from "./routes/ext-cf";
import { accessRoutes } from "./routes/access";
import { sentRoutes } from "./routes/sent";
import { getClientIp, isBlocked, isWhitelisted, recordFail, clearFails } from "./ip-guard";
import { startAllMailboxListeners } from "./listener-manager";
import { hasClawMailConfig } from "./runtime-config";
import { hydrateFromSupabase } from "./hydrate";
import { supabaseConfigured } from "./supabase-sync";

const app = Fastify({
  logger: true,
  trustProxy: 1 // 只信任最近 1 跳反代(HF edge)，request.ip 取其添加的真实 IP；不信全链路防 XFF 伪造绕过封禁
});

function extractAdminPassword(request: any): string | undefined {
  const header = request.headers["x-admin-password"];
  if (typeof header === "string") return header;
  const queryPassword = request.query?.token;
  if (typeof queryPassword === "string") return queryPassword;
  return undefined;
}

app.addHook("onRequest", async (request, reply) => {
  if (request.url === "/health") return;
  // 1) IP 封禁：黑名单/自动封禁的 IP 连页面都打不开（白名单豁免）
  const ip = getClientIp(request);
  if (isBlocked(ip)) {
    return reply.code(403).send({ error: "forbidden", ip });
  }
  // 2) 面板 API 鉴权 + 登录失败计数（失败 N 次自动封禁）
  if (!request.url.startsWith("/api/")) return;
  const password = extractAdminPassword(request);
  if (password !== config.ADMIN_PASSWORD) {
    if (password && !isWhitelisted(ip)) recordFail(ip); // 只对“给了但错的密码”计数
    return reply.code(401).send({ error: "unauthorized" });
  }
  clearFails(ip); // 登录成功清零
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: "invalid input", details: error.issues });
  }
  app.log.error(error);
  return reply.code(500).send({
    error: error instanceof Error ? error.message : "internal server error"
  });
});

app.get("/health", async () => {
  return { ok: true };
});

await mailboxRoutes(app);
await mailRoutes(app);
await clawOpsRoutes(app);
await sendRoutes(app);
await eventRoutes(app);
await clawAuthRoutes(app);
await cfMailRoutes(app);
await aiRoutes(app);
await secretRoutes(app);
await extCfRoutes(app);
await accessRoutes(app);
await sentRoutes(app);

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, "../web");
await app.register(fastifyStatic, {
  root: webRoot,
  prefix: "/"
});

app.setNotFoundHandler(async (_request, reply) => {
  return reply.sendFile("index.html");
});

// 从 Supabase 灌回持久化数据（凭据/邮箱/邮件），再决定是否启动监听器。
if (supabaseConfigured()) {
  await hydrateFromSupabase();
  app.log.info("supabase persistence enabled; hydrated local cache from cloud");
} else {
  app.log.warn("SUPABASE_URL/SUPABASE_SERVICE_KEY not set; data will not survive restarts");
}

if (hasClawMailConfig()) {
  startAllMailboxListeners();
} else {
  app.log.warn("CLAW_API_KEY is not set; mailbox listeners are disabled until configured");
}

await app.listen({ host: "0.0.0.0", port: config.PORT });
