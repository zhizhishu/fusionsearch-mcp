// /api/access —— 后台访问控制：查看被封 IP、黑名单、白名单，并增删。受面板 ADMIN_PASSWORD 守卫。
import type { FastifyInstance } from "fastify";
import {
  accessState,
  getClientIp,
  addWhitelist,
  delWhitelist,
  addBlacklist,
  delBlacklist,
  banIp,
  unbanIp
} from "../ip-guard";

type Body = { action?: string; ip?: string };

export async function accessRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/access", async (request) => {
    return { ...accessState(), currentIp: getClientIp(request) };
  });

  app.post("/api/access", async (request, reply) => {
    const { action, ip } = (request.body ?? {}) as Body;
    const target = (ip ?? "").trim();
    if (!action) return reply.code(400).send({ error: "action required" });
    if (action !== "current" && !target) return reply.code(400).send({ error: "ip required" });
    switch (action) {
      case "unban": unbanIp(target); break;
      case "ban": banIp(target, "手动封禁"); break;
      case "whitelist-add": addWhitelist(target); break;
      case "whitelist-del": delWhitelist(target); break;
      case "blacklist-add": addBlacklist(target); break;
      case "blacklist-del": delBlacklist(target); break;
      default: return reply.code(400).send({ error: `unknown action: ${action}` });
    }
    return { ...accessState(), currentIp: getClientIp(request) };
  });
}
