import type { FastifyInstance } from "fastify";
import type { NormalizedMessage } from "../im/types.js";

// 首响应占位内容:企微智能机器人被动流式需尽快收到"非空首帧"才会进入流式展示。
// 空 content 首响应会让企微端长时间转圈不上屏,最终超时提示"抱歉"。
export const FIRST_REPLY_PLACEHOLDER = "收到，正在处理，请稍候…";

export interface WebhookDeps {
  parseMessage: (body: Buffer, headers: object, botId: string, platform: string) => Promise<NormalizedMessage | null>;
  // 用户消息:同步初始化 stream 状态(content 空 finish=false)再启动异步执行。
  // 返回首响应 streamId。同步初始化保证后续刷新回调能拿到状态(非 null)。
  handleUserMessage: (msg: NormalizedMessage) => Promise<string | null>;
  // 流式刷新回调:按 streamId 返回最新 {content, finish}(或 null 表示无此 stream)
  getStreamState: (streamId: string) => Promise<{ content: string; finish: boolean } | null>;
  // 构造流式加密响应体(由 IMAdapter 提供)
  buildStreamResponse: (streamId: string, content: string, finish: boolean, requestNonce: string) => Promise<string>;
  // 事件回调(如 enter_chat):返回要被动文本回复的内容,返回 null 表示不回复(如当天已清空过)。
  handleEvent?: (msg: any) => Promise<string | null>;
  // 构造被动文本回复的加密响应体(由 IMAdapter 提供,仅进入会话事件支持)
  buildTextResponse?: (content: string, requestNonce: string) => Promise<string>;
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
    // 回调请求的 nonce(响应必须复用)。企微把 nonce 放在 URL query(msg_signature&timestamp&nonce),
    // 而非 header;仅从 header 取会取到空,导致响应 nonce 不匹配、企微拒绝显示。故优先 query,回退 header。
    const q = req.query as Record<string, string | string[] | undefined>;
    const nonce = (typeof q.nonce === "string" ? q.nonce : "") || pickHeader(req.headers, "nonce") || "";

    // 企微把 msg_signature/timestamp/nonce 放 URL query,合并进 headers 供 parseMessage 校验签名。
    const combinedHeaders = { ...req.headers } as Record<string, string | string[] | undefined>;
    for (const k of ["msg_signature", "timestamp", "nonce"] as const) {
      const v = q[k];
      if (v !== undefined) combinedHeaders[k] = v;
    }
    const msg = await deps.parseMessage(body, combinedHeaders, botId, platform).catch((e) => {
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
        req.log.info({ userId: msg.userId, streamId: String(msg.streamId).slice(0, 12), found: !!st, contentLen: st?.content.length ?? 0, finish: st?.finish }, "stream-refresh");
        if (!st) {
          // stream 不存在:可能是 router 异常未初始化状态。
          // 返回空 content finish=false 让企微继续刷新(而非 finish=true 提前结束),
          // 给 router 写入状态的机会(claude 冷启动慢,首次刷新可能早于状态写入)。
          const resp = await deps.buildStreamResponse(msg.streamId, "", false, nonce);
          return reply.code(200).header("content-type", "application/json").send(resp);
        }
        const resp = await deps.buildStreamResponse(msg.streamId, st.content, st.finish, nonce);
        return reply.code(200).header("content-type", "application/json").send(resp);
      }

      // 事件回调(如 enter_chat):清空上下文 + 被动文本回复欢迎语。
      // 事件无 streamId,也不走 CLI 会话,故在用户消息分支前单独处理。
      if (msg.eventType) {
        if (!deps.handleEvent || !deps.buildTextResponse) {
          return reply.code(200).send({ status: "success" });
        }
        const content = await deps.handleEvent(msg).catch((e) => {
          req.log.error({ err: e, userId: msg.userId }, "handleEvent 异常");
          return null;
        });
        if (!content) {
          // 无回复内容(如当天已清空过),空回 success
          return reply.code(200).send({ status: "success" });
        }
        const resp = await deps.buildTextResponse(content, nonce);
        req.log.info({ userId: msg.userId, botId: msg.botId, eventType: msg.eventType, contentLen: content.length }, "event-reply");
        return reply.code(200).header("content-type", "application/json").send(resp);
      }

      // 用户消息:handleUserMessage 同步初始化 stream 状态 + 异步启动执行,
      // 返回 streamId 作首响应(5s 内必须返回)。同步初始化保证刷新回调能拿到状态。
      const streamId = await deps.handleUserMessage(msg).catch((e) => {
        req.log.error({ err: e, userId: msg.userId }, "handleUserMessage 异常");
        return null;
      });
      if (!streamId) {
        return reply.code(200).send({ status: "success" });
      }
      req.log.info({ userId: msg.userId, streamId: String(streamId).slice(0, 12), text: msg.text?.slice(0, 200) }, "user-msg-stream");
      // 首响应:返回非空占位内容(finish=false),让企微端立即进入流式展示,避免长时间转圈超时。
      const resp = await deps.buildStreamResponse(streamId, FIRST_REPLY_PLACEHOLDER, false, nonce);
      return reply.code(200).header("content-type", "application/json").send(resp);
    } catch (e) {
      req.log.error({ err: e, userId: msg.userId }, "webhook 响应构造异常");
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
