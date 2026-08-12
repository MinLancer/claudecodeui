import { describe, it, expect } from "vitest";
import { createApp } from "../../src/server/app.js";
import { WeComAdapter } from "../../src/im/wecom.js";
import { WeComCrypto } from "../../src/im/wecom-crypto.js";

// 集成测试:真实 WeComAdapter + 真实加解密,验证 application/json body 以 Buffer 传参。
// 回归用例:曾因 Fastify 默认 JSON parser 把 body 解析成对象,
// parseMessage 收到对象导致 JSON.parse("[object Object]") 失败返回 null,网关回 success。
describe("webhook 真实 body 解析", () => {
  const cred = { aesKey: "w3godUGB2LVvAJMj15Et3Un1US20DA9ql7Pz9yQpjXD", token: "test-token-1234" };
  const crypto = new WeComCrypto(cred);
  const adapter = new WeComAdapter(cred as any, "wecom_1");

  const parseMessage = (body: Buffer, headers: object) =>
    adapter.parseMessage(body, headers);

  it("application/json 消息 body 以 Buffer 传入,能正确解密解析并返回流式首响应", async () => {
    const handleUserMessage = async (msg: any) => { expect(msg.text).toBe("你好"); return "sid-1"; };
    const app = createApp({
      parseMessage,
      handleUserMessage,
      getStreamState: async () => null,
      buildStreamResponse: async (sid: string, content: string, finish: boolean) =>
        JSON.stringify({ sid, content, finish }),
    });

    // 构造加密用户消息
    const inner = {
      msgid: "m9001", aibotid: "botx", chattype: "single",
      from: { userid: "u1" }, msgtype: "text", text: { content: "你好" },
    };
    const encrypt = crypto.encrypt(JSON.stringify(inner));

    const res = await app.inject({
      method: "POST", url: "/webhook/wecom/wecom_1",
      payload: JSON.stringify({ encrypt }), // 关键:真实 application/json body
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 若 body 被错误解析为对象导致 parseMessage null,会返回 {status:"success"}
    expect(body).not.toEqual({ status: "success" });
    expect(body.sid).toBe("sid-1");
  });

  it("nonce 从 URL query 取(企微放 query 而非 header),并传给 buildStreamResponse", async () => {
    let capturedNonce: string | undefined;
    // 专注测 webhook 的 nonce 传递逻辑:parseMessage 直接返回消息,绕过签名校验(第一个测试已覆盖真实加解密)
    const app = createApp({
      parseMessage: async () => ({
        msgId: "m9002", botId: "wecom_1", chatSceneId: "p2p:u1",
        userId: "u1", text: "你好",
      }),
      handleUserMessage: async () => "sid-nonce",
      getStreamState: async () => null,
      buildStreamResponse: async (_sid, _content, _finish, nonce) => {
        capturedNonce = nonce;
        return JSON.stringify({ nonce });
      },
    });

    const res = await app.inject({
      method: "POST",
      // 企微把 msg_signature/timestamp/nonce 放 URL query(而非 header)
      url: "/webhook/wecom/wecom_1?msg_signature=abc&timestamp=123&nonce=QUERY_NONCE",
      payload: JSON.stringify({ encrypt: "dummy" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(200);
    // 响应 nonce 必须与 query 一致,否则企微拒绝显示
    expect(capturedNonce).toBe("QUERY_NONCE");
  });
});
