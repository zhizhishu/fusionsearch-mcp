// /api/ai/* —— 右下角 AI 气泡的后端：跑助手 + 配置 LLM 端点。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runAgent, execPlan, listModels, type ChatMessage } from "../ai-agent";
import { aiConfigured, getAiConfigStatus, saveAiConfig, clearAiConfig } from "../runtime-config";

const chatBody = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant", "tool", "system"]),
      content: z.string()
    })
  ).min(1).max(40),
  dryRun: z.boolean().optional() // 默认 true：危险动作先返回计划等确认
});

const execBody = z.object({
  plan: z.array(z.object({ name: z.string(), args: z.any() })).min(1).max(10)
});

const configBody = z.object({
  baseUrl: z.string().min(1),
  model: z.string().optional(),
  apiKey: z.string().optional()
});

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/ai/config", async () => {
    return getAiConfigStatus();
  });

  app.post("/api/ai/config", async (request) => {
    const body = configBody.parse(request.body);
    saveAiConfig(body);
    return getAiConfigStatus();
  });

  app.delete("/api/ai/config", async () => {
    clearAiConfig();
    return getAiConfigStatus();
  });

  app.post("/api/ai/models", async (request, reply) => {
    const body = (request.body ?? {}) as { baseUrl?: string; apiKey?: string };
    try {
      return { models: await listModels(body.baseUrl, body.apiKey) };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/ai/chat", async (request, reply) => {
    if (!aiConfigured()) {
      return reply.code(409).send({ error: "AI 未配置：请先在设置里填入模型端点(base_url)和 key" });
    }
    const body = chatBody.parse(request.body);
    try {
      const result = await runAgent(body.messages as ChatMessage[], { dryRun: body.dryRun !== false });
      return result;
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // 确认后直接执行已决定的 plan（不再过 LLM，确认即所见即所执行）
  app.post("/api/ai/exec", async (request, reply) => {
    const body = execBody.parse(request.body);
    try {
      return await execPlan(body.plan as { name: string; args: any }[]);
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
