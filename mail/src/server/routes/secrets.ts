// /api/secrets —— 在管理员门后揭示真实凭据，供设置页「凭据·可复制」用。
// 整个 /api/* 已被 ADMIN_PASSWORD 门拦住（index.ts onRequest），没登录的人取不到。
// 仅按需拉取（前端点「加载凭据」才调），平时不下发明文。
import type { FastifyInstance } from "fastify";
import { listProviders } from "../temp-providers";
import { getClawApiKey, getDashboardCookie, getAiApiKey } from "../runtime-config";

export async function secretRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/secrets", async () => {
    return {
      temp: listProviders().map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        endpoint: p.endpoint,
        domain: p.domain,
        password: p.password || null
      })),
      claw: {
        apiKey: getClawApiKey() ?? null,
        hasCookie: Boolean(getDashboardCookie())
      },
      ai: {
        apiKey: getAiApiKey() ?? null
      }
    };
  });
}
