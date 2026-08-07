import { parseStringPromise } from "xml2js";
import type { IMAdapter, NormalizedMessage, SendOpts } from "./types.js";

// 企微凭证
export interface WeComCredentials {
  corpId: string;
  secret: string;
  aesKey: string;
  token: string;
}

// 解密注入点:生产用 @wecom/crypto,测试注入桩
export interface WeComCrypto {
  decrypt(encrypted: string): Promise<string>;
}

export class WeComAdapter implements IMAdapter {
  platform = "wecom" as const;

  constructor(
    private creds: WeComCredentials,
    private crypto: WeComCrypto,
    private botId: string,
  ) {}

  async parseMessage(rawBody: Buffer, _headers: object): Promise<NormalizedMessage | null> {
    const plain = await this.crypto.decrypt(rawBody.toString("utf8"));
    const xml = await parseStringPromise(plain, { explicitArray: false });
    const m = xml.xml;
    if (m.MsgType !== "text") return null;

    const userId = String(m.FromUserName);
    // 企微群聊消息含 ChatId;私聊无
    const chatSceneId = m.ChatId ? `group:${m.ChatId}` : `p2p:${userId}`;
    return {
      botId: this.botId,
      msgId: String(m.MsgId),
      chatSceneId,
      userId,
      text: String(m.Content),
    };
  }

  async sendMessage(opts: SendOpts): Promise<void> {
    // 生产:调企微主动发消息 API(POST /cgi-bin/message/send)
    // 含 access_token 获取与缓存。本骨架留 TODO,Task 7 联调时补全。
    // 这里仅保证接口契约,群聊带 @,私聊直发。
    const _ = opts;
    throw new Error("WeComAdapter.sendMessage 待 Task 7 联调实现");
  }
}
