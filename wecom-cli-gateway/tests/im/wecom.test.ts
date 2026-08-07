import { describe, it, expect } from "vitest";
import { WeComAdapter } from "../../src/im/wecom.js";

// 企微回调为加密的 XML,这里用简化桩验证"解密后能归一化"。
// 真实验签/解密依赖 @wecom/crypto,本测试通过注入解密函数隔离。
describe("WeComAdapter", () => {
  const creds = { corpId: "c", secret: "s", aesKey: "aes", token: "t" };

  it("私聊消息归一化为 p2p 场景", async () => {
    // 注入假 decrypt:返回固定明文 XML
    const adapter = new WeComAdapter(creds, {
      decrypt: async () => `<xml>
        <MsgId>100</MsgId>
        <FromUserName>zhangsan</FromUserName>
        <Content>帮我看下</Content>
        <MsgType>text</MsgType>
      </xml>`,
    }, "wecom_1");
    const msg = await adapter.parseMessage(Buffer.from("enc"), {});
    expect(msg).not.toBeNull();
    expect(msg!.botId).toBe("wecom_1"); // 由构造注入,多机器人各自不同
    expect(msg!.msgId).toBe("100");
    expect(msg!.chatSceneId).toBe("p2p:zhangsan");
    expect(msg!.userId).toBe("zhangsan");
    expect(msg!.text).toBe("帮我看下");
  });

  it("非 text 消息返回 null", async () => {
    const adapter = new WeComAdapter(creds, {
      decrypt: async () => `<xml>
        <MsgId>101</MsgId>
        <FromUserName>zhangsan</FromUserName>
        <MsgType>event</MsgType>
      </xml>`,
    }, "wecom_1");
    const msg = await adapter.parseMessage(Buffer.from("enc"), {});
    expect(msg).toBeNull();
  });
});
