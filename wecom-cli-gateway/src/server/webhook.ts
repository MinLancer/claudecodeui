import type { FastifyInstance } from "fastify";
import type { NormalizedMessage } from "../im/types.js";

export interface WebhookDeps {
  parseMessage: (body: Buffer, headers: object, botId: string, platform: string) => Promise<NormalizedMessage | null>;
  routerHandle: (msg: NormalizedMessage) => Promise<void>;
  // GET 验证 URL:企微保存回调配置时发 GET,需解密 echostr 并回显明文(1s 内,纯净无引号无换行)
  verifyUrl?: (query: Record<string, string>, botId: string, platform: string) => Promise<string | null>;
}

export function registerWebhook(app: FastifyInstance, deps: WebhookDeps) {
  // GET 验证 URL:企微保存回调配置时 GET ?msg_signature&timestamp&nonce&echostr
  app.get("/webhook/:platform/:botId", async (req, reply) => {
    const { platform, botId } = req.params as { platform: string; botId: string };
    if (!deps.verifyUrl) return reply.code(404).send("not configured");
    const q = req.query as Record<string, string>;
    const echo = await deps.verifyUrl(q, botId, platform);
    if (echo === null) return reply.code(403).send("verify failed");
    // 回显明文:不能加引号/BOM/换行
    return reply.code(200).header("content-type", "text/plain").send(echo);
  });

  // POST 业务回调:企微推送加密消息
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
