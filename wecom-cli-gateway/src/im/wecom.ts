import type { IMAdapter, NormalizedMessage, SendOpts } from "./types.js";
import { WeComCrypto } from "./wecom-crypto.js";

/**
 * 企业微信智能机器人适配器。
 *
 * 与企业微信自建应用不同:
 * - 回调是加密 JSON(非 XML):body 为 {"encrypt":"..."},解密后 JSON 含
 *   msgid/aibotid/chatid/chattype/from.userid/response_url/msgtype/text 等
 * - 回复用回调携带的 response_url(POST cgi-bin/aibot/response?response_code=xxx),
 *   非传统 cgi-bin/message/send。response_url 1 小时有效,仅可用 1 次
 * - 加解密:Token + EncodingAESKey(AES-256-CBC + SHA1 签名),receiveid 为空串
 *
 * 参考:
 * - 接收消息: https://developer.work.weixin.qq.com/document/path/100719
 * - 主动回复: https://developer.work.weixin.qq.com/document/path/101138
 * - 加解密: https://developer.work.weixin.qq.com/document/path/101033
 */
export interface WeComCredentials {
  aesKey: string; // 43 字符 EncodingAESKey
  token: string;
}

export class WeComAdapter implements IMAdapter {
  platform = "wecom" as const;
  private crypto: WeComCrypto;

  constructor(
    private creds: WeComCredentials,
    private botId: string,
  ) {
    this.crypto = new WeComCrypto({ aesKey: creds.aesKey, token: creds.token });
  }

  async parseMessage(rawBody: Buffer, headers: object): Promise<NormalizedMessage | null> {
    // 1. URL 验证(GET 请求由 webhook 层处理 echostr;此处只处理 POST 业务回调)
    // 2. POST body: {"encrypt":"..."}
    let outer: { encrypt?: string };
    try {
      outer = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return null;
    }
    if (!outer.encrypt) return null;

    // 3. 签名校验(若 headers 带 msg_signature/timestamp/nonce)
    const h = headers as Record<string, string | string[] | undefined>;
    const msgSignature = pickHeader(h, "msg_signature");
    const timestamp = pickHeader(h, "timestamp");
    const nonce = pickHeader(h, "nonce");
    if (msgSignature && timestamp && nonce) {
      if (!this.crypto.verifySign(timestamp, nonce, outer.encrypt, msgSignature)) {
        return null; // 签名不通过
      }
    }

    // 4. 解密 -> 明文 JSON
    const plain = this.crypto.decrypt(outer.encrypt);
    const m = JSON.parse(plain);

    // 5a. 流式刷新回调:msgtype=stream,含 stream.id。归一化为带 streamId 的消息(webhook 据此拉 chunk)
    if (m.msgtype === "stream" && m.stream?.id) {
      return {
        botId: this.botId,
        msgId: String(m.msgid ?? ""),
        chatSceneId: "", // 刷新回调无会话上下文,webhook 用 streamId 查 Redis
        userId: "",
        text: "",
        streamId: String(m.stream.id),
      };
    }

    // 5a2. 进入会话事件:用户当天首次进入单聊(无 response_url/chatid,无文本)。
    // webhook 据此清空上下文 + 被动文本回复欢迎语,而非启动 CLI 会话。
    if (m.msgtype === "event" && m.event?.eventtype === "enter_chat") {
      const userId = String(m.from?.userid ?? "");
      return {
        botId: this.botId,
        msgId: String(m.msgid ?? ""),
        chatSceneId: `p2p:${userId}`,
        userId,
        text: "",
        eventType: "enter_chat",
      };
    }

    // 5b. 用户文本消息(其他类型图片/语音等本期忽略)
    if (m.msgtype !== "text") return null;

    const userId = String(m.from?.userid ?? "");
    // chattype: single(私聊)/ group(群聊);chatid 仅群聊有
    const isGroup = m.chattype === "group";
    const chatSceneId = isGroup ? `group:${m.chatid}` : `p2p:${userId}`;

    // 群聊消息文本含 "@机器人名" 前缀,需剥离(机器人被 @ 触发,content 含 @RobotA)
    let text = String(m.text?.content ?? "");
    if (isGroup) {
      text = text.replace(/^@\S+\s*/, "");
    }

    return {
      botId: this.botId,
      msgId: String(m.msgid),
      chatSceneId,
      userId,
      text: text.trim(),
      responseUrl: m.response_url ? String(m.response_url) : undefined,
    };
  }

  /**
   * 构造流式被动回复的加密响应体。
   * 响应格式(文档 101033):{encrypt, msgsignature, timestamp, nonce}
   * - encrypt: 加密后的 {msgtype:"stream", stream:{id, content, finish}}
   * - nonce: 必须复用回调请求的 nonce(企微校验)
   */
  async buildStreamResponse(streamId: string, content: string, finish: boolean, requestNonce: string): Promise<string> {
    const inner = {
      msgtype: "stream" as const,
      stream: {
        id: streamId,
        content,
        finish,
      },
    };
    const encrypt = this.crypto.encrypt(JSON.stringify(inner));
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const msgsignature = this.crypto.sign(timestamp, requestNonce, encrypt);
    return JSON.stringify({ encrypt, msgsignature, timestamp, nonce: requestNonce });
  }

  /**
   * 构造被动文本回复的加密响应体(仅进入会话事件支持文本被动回复)。
   * 内部结构:{msgtype:"text", text:{content}},外包标准加密签名,nonce 复用回调请求的 nonce。
   */
  async buildTextResponse(content: string, requestNonce: string): Promise<string> {
    const inner = {
      msgtype: "text" as const,
      text: { content },
    };
    const encrypt = this.crypto.encrypt(JSON.stringify(inner));
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const msgsignature = this.crypto.sign(timestamp, requestNonce, encrypt);
    const raw = JSON.stringify({ encrypt, msgsignature, timestamp, nonce: requestNonce });
    console.log("[wecom] TEXT wire nonce="+requestNonce+" stamp="+timestamp+" sign="+msgsignature+" encLen="+encrypt.length+" body="+raw);
    return raw;
  }

  /**
   * GET 验证 URL:企微保存回调配置时发 GET ?msg_signature&timestamp&nonce&echostr。
   * 校验签名 + 解密 echostr,返回明文(回显时不能加引号/BOM/换行)。
   * 失败返回 null(由 webhook 层回 403)。
   */
  async verifyUrl(query: Record<string, string>): Promise<string | null> {
    const { msg_signature, timestamp, nonce, echostr } = query;
    if (!msg_signature || !timestamp || !nonce || !echostr) return null;
    if (!this.crypto.verifySign(timestamp, nonce, echostr, msg_signature)) return null;
    return this.crypto.decrypt(echostr);
  }

  async sendMessage(opts: SendOpts): Promise<void> {
    // 智能机器人用回调携带的 response_url 主动回复(markdown 格式,一次性)
    if (!opts.responseUrl) {
      throw new Error("WeComAdapter.sendMessage 缺少 responseUrl(智能机器人须用回调携带的 response_url 回复)");
    }
    const body = {
      msgtype: "markdown" as const,
      markdown: {
        content: opts.text,
      },
    };
    const res = await fetch(opts.responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`企微回复失败 ${res.status}: ${errText.slice(0, 200)}`);
    }
    const result = await res.json().catch(() => ({})) as { errcode?: number; errmsg?: string };
    if (result.errcode && result.errcode !== 0) {
      throw new Error(`企微回复错误 ${result.errcode}: ${result.errmsg ?? ""}`);
    }
  }
}

function pickHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  // 大小写不敏感查 header
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}
