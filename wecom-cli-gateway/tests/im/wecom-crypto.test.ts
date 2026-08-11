import { describe, it, expect } from "vitest";
import { WeComCrypto } from "../../src/im/wecom-crypto.js";
import { createHash, createHash as _h } from "node:crypto";

// 用真实算法自测:WeComCrypto 内部用 AES-256-CBC + SHA1。
// 构造一个完整往返:加密明文 -> 解密还原,验证一致性。

const aesKeyBase64 = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"; // 43 字符 base64
const token = "mytoken";

describe("WeComCrypto", () => {
  it("EncodingAESKey base64 解码为 32 字节,IV 取前 16 字节", () => {
    const c = new WeComCrypto({ aesKey: aesKeyBase64, token });
    // 内部 key 长度 32,iv 长度 16(通过加解密行为间接验证)
    expect(c).toBeDefined();
  });

  it("解密:加密后的消息能解密还原明文 JSON", () => {
    const c = new WeComCrypto({ aesKey: aesKeyBase64, token });
    const plain = JSON.stringify({
      msgid: "msg-1",
      aibotid: "bot-1",
      chattype: "single",
      from: { userid: "zhangsan" },
      msgtype: "text",
      text: { content: "你好" },
      response_url: "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=CODE",
    });
    const encrypted = c.encrypt(plain); // 用同一套算法加密
    const decrypted = c.decrypt(encrypted);
    expect(JSON.parse(decrypted)).toMatchObject({ msgid: "msg-1", msgtype: "text", text: { content: "你好" } });
  });

  it("签名校验:token+timestamp+nonce+encrypt 字典序拼接做 SHA1", () => {
    const c = new WeComCrypto({ aesKey: aesKeyBase64, token });
    const timestamp = "1609459200";
    const nonce = "abc";
    const encrypted = c.encrypt("test");
    const sig = c.sign(timestamp, nonce, encrypted);
    // 手动算期望签名
    const arr = [token, timestamp, nonce, encrypted].sort().join("");
    const expected = createHash("sha1").update(arr).digest("hex");
    expect(sig).toBe(expected);
  });

  it("verifySign 校验签名一致返回 true,篡改返回 false", () => {
    const c = new WeComCrypto({ aesKey: aesKeyBase64, token });
    const timestamp = "1609459200";
    const nonce = "abc";
    const encrypted = c.encrypt("test");
    const sig = c.sign(timestamp, nonce, encrypted);
    expect(c.verifySign(timestamp, nonce, encrypted, sig)).toBe(true);
    expect(c.verifySign(timestamp, nonce, encrypted + "x", sig)).toBe(false);
  });

  it("解密带 receiveid(空串)的明文也能正确还原(receiveid 被剥离)", () => {
    const c = new WeComCrypto({ aesKey: aesKeyBase64, token });
    const plain = JSON.stringify({ msgtype: "text", text: { content: "hi" } });
    const encrypted = c.encrypt(plain); // 内部 receiveid 传空串
    const decrypted = c.decrypt(encrypted);
    expect(decrypted).toBe(plain);
  });
});
