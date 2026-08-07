import type { FastifyInstance } from "fastify";
import type { NormalizedMessage } from "../im/types.js";

export interface WebhookDeps {
  parseMessage: (body: Buffer, headers: object, botId: string, platform: string) => Promise<NormalizedMessage | null>;
  routerHandle: (msg: NormalizedMessage) => Promise<void>;
}

export function registerWebhook(app: FastifyInstance, deps: WebhookDeps) {
  app.post("/webhook/:platform/:botId", async (req, reply) => {
    const { platform, botId } = req.params as { platform: string; botId: string };
    const body = (req.body as Buffer | undefined) ?? Buffer.from("");
    // 企微要求 5s 内响应:解析后立即异步执行,主线程回 success
    deps.parseMessage(body, req.headers, botId, platform)
      .then((msg) => { if (msg) return deps.routerHandle(msg); })
      .catch((e) => req.log.error({ err: e }, "webhook 处理异常"));
    return reply.code(200).send({ status: "success" });
  });
}
