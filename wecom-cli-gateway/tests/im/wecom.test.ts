import { describe, it, expect, vi } from "vitest";
import { WeComAdapter } from "../../src/im/wecom.js";
import { WeComCrypto } from "../../src/im/wecom-crypto.js";

// 智能机器人回调:POST body = {"encrypt": "<base64密文>"},解密后为 JSON。
// 用真实 WeComCrypto 加解密构造完整往返。
const aesKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"; // 43 字符
const token = "mytoken";

function encryptMsg(plain: object): { body: Buffer; sig: string; ts: string; nonce: string } {
  const crypto = new WeComCrypto({ aesKey, token });
  const plainStr = JSON.stringify(plain);
  const encrypted = crypto.encrypt(plainStr);
  const ts = "1609459200";
  const nonce = "abc";
  const sig = crypto.sign(ts, nonce, encrypted);
  return { body: Buffer.from(JSON.stringify({ encrypt: encrypted })), sig, ts, nonce };
}

describe("WeComAdapter", () => {
  it("私聊文本消息归一化为 p2p 场景", async () => {
    const { body, sig, ts, nonce } = encryptMsg({
      msgid: "msg-1",
      aibotid: "bot-1",
      chattype: "single",
      from: { userid: "zhangsan" },
      msgtype: "text",
      text: { content: "帮我看下" },
      response_url: "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=CODE1",
    });
    const adapter = new WeComAdapter({ aesKey, token }, "wecom_1");
    const msg = await adapter.parseMessage(body, { msg_signature: sig, timestamp: ts, nonce });
    expect(msg).not.toBeNull();
    expect(msg!.botId).toBe("wecom_1");
    expect(msg!.msgId).toBe("msg-1");
    expect(msg!.chatSceneId).toBe("p2p:zhangsan");
    expect(msg!.userId).toBe("zhangsan");
    expect(msg!.text).toBe("帮我看下");
    expect(msg!.responseUrl).toContain("response_code=CODE1");
  });

  it("群聊文本消息归一化为 group 场景,剥离 @机器人 前缀", async () => {
    const { body, sig, ts, nonce } = encryptMsg({
      msgid: "msg-2",
      aibotid: "bot-1",
      chatid: "group-123",
      chattype: "group",
      from: { userid: "zhangsan" },
      msgtype: "text",
      text: { content: "@RobotA 帮我看下" },
      response_url: "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=CODE2",
    });
    const adapter = new WeComAdapter({ aesKey, token }, "wecom_1");
    const msg = await adapter.parseMessage(body, { msg_signature: sig, timestamp: ts, nonce });
    expect(msg).not.toBeNull();
    expect(msg!.chatSceneId).toBe("group:group-123");
    expect(msg!.userId).toBe("zhangsan");
    expect(msg!.text).toBe("帮我看下"); // @RobotA 已剥离
  });

  it("非 text 消息返回 null", async () => {
    const { body, sig, ts, nonce } = encryptMsg({
      msgid: "msg-3",
      chattype: "single",
      from: { userid: "zhangsan" },
      msgtype: "image",
      response_url: "x",
    });
    const adapter = new WeComAdapter({ aesKey, token }, "wecom_1");
    const msg = await adapter.parseMessage(body, { msg_signature: sig, timestamp: ts, nonce });
    expect(msg).toBeNull();
  });

  it("签名校验失败返回 null", async () => {
    const { body } = encryptMsg({
      msgid: "msg-4",
      chattype: "single",
      from: { userid: "zhangsan" },
      msgtype: "text",
      text: { content: "hi" },
    });
    const adapter = new WeComAdapter({ aesKey, token }, "wecom_1");
    const msg = await adapter.parseMessage(body, { msg_signature: "invalid", timestamp: "1609459200", nonce: "abc" });
    expect(msg).toBeNull();
  });

  it("sendMessage 用 response_url POST markdown", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"errcode":0,"errmsg":"ok"}', { status: 200, headers: { "content-type": "application/json" } }),
    );
    const adapter = new WeComAdapter({ aesKey, token }, "wecom_1");
    await adapter.sendMessage({
      toUser: "zhangsan",
      text: "# 标题\n回复内容",
      responseUrl: "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=CODE",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("response_code=CODE");
    expect(init?.method).toBe("POST");
    const body = JSON.parse((init as any).body);
    expect(body.msgtype).toBe("markdown");
    expect(body.markdown.content).toContain("回复内容");
    fetchMock.mockRestore();
  });

  it("sendMessage 缺 responseUrl 抛错", async () => {
    const adapter = new WeComAdapter({ aesKey, token }, "wecom_1");
    await expect(adapter.sendMessage({ toUser: "zhangsan", text: "hi" })).rejects.toThrow(/responseUrl/);
  });

  it("sendMessage 企微返回错误码时抛错", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"errcode":40001,"errmsg":"invalid credential"}', { status: 200 }),
    );
    const adapter = new WeComAdapter({ aesKey, token }, "wecom_1");
    await expect(
      adapter.sendMessage({ toUser: "zhangsan", text: "hi", responseUrl: "https://x" }),
    ).rejects.toThrow(/40001/);
    vi.restoreAllMocks();
  });

  it("端到端:parseMessage 解密出的 responseUrl 能传给 sendMessage 回复", async () => {
    // 模拟真实链路:企微回调 -> 解密归一化(含 responseUrl)-> sendMessage 用 responseUrl 回复
    const { body, sig, ts, nonce } = encryptMsg({
      msgid: "msg-e2e",
      chattype: "single",
      from: { userid: "zhangsan" },
      msgtype: "text",
      text: { content: "你好" },
      response_url: "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=E2E",
    });
    const adapter = new WeComAdapter({ aesKey, token }, "wecom_1");
    const msg = await adapter.parseMessage(body, { msg_signature: sig, timestamp: ts, nonce });
    expect(msg!.responseUrl).toContain("response_code=E2E");

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"errcode":0}', { status: 200 }),
    );
    await adapter.sendMessage({ toUser: msg!.userId, text: "回复你好", responseUrl: msg!.responseUrl });
    expect(fetchMock.mock.calls[0][0]).toContain("response_code=E2E");
    fetchMock.mockRestore();
  });

  it("流式刷新回调:parseMessage 解析 stream 类型并返回 streamId", async () => {
    const { body, sig, ts, nonce } = encryptMsg({
      msgtype: "stream",
      stream: { id: "stream-xyz" },
    });
    const adapter = new WeComAdapter({ aesKey, token }, "wecom_1");
    const msg = await adapter.parseMessage(body, { msg_signature: sig, timestamp: ts, nonce });
    expect(msg).not.toBeNull();
    expect(msg!.streamId).toBe("stream-xyz");
  });

  it("buildStreamResponse:返回加密的响应体(含 encrypt/msgsignature/timestamp/nonce)", async () => {
    const adapter = new WeComAdapter({ aesKey, token }, "wecom_1");
    const resp = await adapter.buildStreamResponse("stream-1", "部分内容", false, "nonce-abc");
    const obj = JSON.parse(resp);
    expect(obj.encrypt).toBeTruthy();
    expect(obj.msgsignature).toBeTruthy();
    expect(obj.timestamp).toBeTruthy();
    expect(obj.nonce).toBe("nonce-abc"); // 复用请求 nonce

    // 解密 encrypt 验证内部 stream 结构
    const crypto = new WeComCrypto({ aesKey, token });
    const plain = crypto.decrypt(obj.encrypt);
    const inner = JSON.parse(plain);
    expect(inner.msgtype).toBe("stream");
    expect(inner.stream.id).toBe("stream-1");
    expect(inner.stream.content).toBe("部分内容");
    expect(inner.stream.finish).toBe(false);

    // 签名校验应通过
    expect(crypto.verifySign(obj.timestamp, obj.nonce, obj.encrypt, obj.msgsignature)).toBe(true);
  });

  it("buildStreamResponse finish=true 时 stream.finish 为 true", async () => {
    const adapter = new WeComAdapter({ aesKey, token }, "wecom_1");
    const resp = await adapter.buildStreamResponse("stream-2", "完成", true, "n1");
    const obj = JSON.parse(resp);
    const crypto = new WeComCrypto({ aesKey, token });
    const inner = JSON.parse(crypto.decrypt(obj.encrypt));
    expect(inner.stream.finish).toBe(true);
  });
});
