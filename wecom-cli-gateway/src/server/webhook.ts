import type { FastifyInstance } from "fastify";
import type { NormalizedMessage } from "../im/types.js";

export interface WebhookDeps {
  parseMessage: (body: Buffer, headers: object, botId: string, platform: string) => Promise<NormalizedMessage | null>;
  // 用户消息:异步启动执行(CLI 跑 + chunk 写 Redis),返回首响应用的 streamId
  handleUserMessage: (msg: NormalizedMessage) => Promise<string | null>;
  // 流式刷新回调:按 streamId 返回最新 {content, finish}(或 null 表示无此 stream)
  getStreamState: (streamId: string) => Promise<{ content: string; finish: boolean } | null>;
  // 构造流式加密响应体(由 IMAdapter 提供)
  buildStreamResponse: (streamId: string, content: string, finish: boolean, requestNonce: string) => Promise<string>;
  // GET 验证 URL
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
    return reply.code(200).header("content-type", "text/plain").send(echo);
  });

  // POST 业务回调:用户消息 or 流式刷新回调
  app.post("/webhook/:platform/:botId", async (req, reply) => {
    const { botId, platform } = req.params as { platform: string; botId: string };
    const body = (req.body as Buffer | undefined) ?? Buffer.from("");
    // 回调请求的 nonce(响应必须复用)
    const nonce = pickHeader(req.headers, "nonce") ?? "";

    const msg = await deps.parseMessage(body, req.headers, botId, platform).catch((e) => {
      req.log.error({ err: e }, "parseMessage 异常");
      return null;
    });
    if (!msg) {
      return reply.code(200).send({ status: "success" }); // 非消息/解析失败,空回
    }

    try {
      // 流式刷新回调:msg.streamId 存在 -> 从 Redis 拉最新状态返回
      if (msg.streamId) {
        const st = await deps.getStreamState(msg.streamId);
        if (!st) {
          // stream 不存在(超时/未找到):返回空内容 finish=true 结束
          const resp = await deps.buildStreamResponse(msg.streamId, "", true, nonce);
          return reply.code(200).header("content-type", "application/json").send(resp);
        }
        const resp = await deps.buildStreamResponse(msg.streamId, st.content, st.finish, nonce);
        return reply.code(200).header("content-type", "application/json").send(resp);
      }

      // 用户消息:异步启动执行(不阻塞),返回 stream 首响应(content 空,finish:false)
      // 异步触发,不 await(5s 内必须返回首响应)
      deps.handleUserMessage(msg).catch((e) => req.log.error({ err: e }, "handleUserMessage 异常"));
      // 首响应 streamId:用 msgId 派生(同一消息的刷新回调会带此 id)
      // 注意:首响应 streamId 必须与后续刷新回调里的 stream.id 一致。
      // 但刷新回调的 stream.id 是企微按我们首响应的 id 推回的,所以这里生成 id 即可。
      // 用 msgId 作 streamId 保证幂等(去重时同一消息不重复生成)
      const streamId = msg.msgId;
      const resp = await deps.buildStreamResponse(streamId, "", false, nonce);
      return reply.code(200).header("content-type", "application/json").send(resp);
    } catch (e) {
      req.log.error({ err: e }, "webhook 响应构造异常");
      return reply.code(200).send({ status: "success" });
    }
  });
}

function pickHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}
