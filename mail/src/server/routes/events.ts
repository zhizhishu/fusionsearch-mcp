import type { FastifyInstance } from "fastify";
import { sseHub } from "../sse";
import { listenerSnapshot } from "../listener-manager";

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/events", async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    const remove = sseHub.add(reply.raw);
    reply.raw.on("close", remove);
  });

  app.get("/api/listeners", async () => {
    return { items: listenerSnapshot() };
  });
}
