import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * 企业微信智能机器人加解密。
 *
 * 算法(企微通用加解密方案):
 * - AES-256-CBC,PKCS#7 填充
 * - 密钥:EncodingAESKey(43 字符 base64)base64 解码得 32 字节
 * - IV:密钥前 16 字节
 * - 明文格式:random(16B) + msg_len(4B 大端) + msg + receiveid
 *   智能机器人场景 receiveid 为空字符串
 * - 签名:SHA1(sort([token, timestamp, nonce, encrypt]).join(""))
 *
 * 参考:
 * - https://developer.work.weixin.qq.com/document/path/101033
 * - https://developer.work.weixin.qq.com/document/path/90968
 */
export interface WeComCryptoOpts {
  aesKey: string; // 43 字符 EncodingAESKey
  token: string;
}

const RECEIVE_ID = ""; // 智能机器人场景 receiveid 为空

export class WeComCrypto {
  private readonly key: Buffer; // 32 字节
  private readonly iv: Buffer; // 前 16 字节
  private readonly token: string;

  constructor(opts: WeComCryptoOpts) {
    // EncodingAESKey 是 43 字符 base64,补 "=" 后 base64 解码得 32 字节密钥
    this.key = Buffer.from(opts.aesKey + "=", "base64");
    if (this.key.length !== 32) {
      throw new Error(`EncodingAESKey 解码后应为 32 字节,实际 ${this.key.length}`);
    }
    this.iv = this.key.subarray(0, 16);
    this.token = opts.token;
  }

  /** 加密明文消息 -> base64 密文(用于自测与被动回复加密) */
  encrypt(plain: string): string {
    const random = randomBytes(16);
    const msgBuf = Buffer.from(plain, "utf8");
    const receiveBuf = Buffer.from(RECEIVE_ID, "utf8");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(msgBuf.length, 0);
    const raw = Buffer.concat([random, lenBuf, msgBuf, receiveBuf]);
    const cipher = createCipheriv("aes-256-cbc", this.key, this.iv);
    cipher.setAutoPadding(true); // PKCS#7
    const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);
    return encrypted.toString("base64");
  }

  /** 解密 base64 密文 -> 明文消息 */
  decrypt(encryptedBase64: string): string {
    const encrypted = Buffer.from(encryptedBase64, "base64");
    const decipher = createDecipheriv("aes-256-cbc", this.key, this.iv);
    // 企微用 PKCS7 填充至 32 字节倍数(非 AES 标准 16 倍数),
    // Node 的 setAutoPadding 按 16 倍数去 padding 会失败(bad decrypt)。
    // 关闭自动 padding,手动按明文格式解析(random+msg_len+msg+receiveid)。
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    // 明文格式:random(16) + msg_len(4,大端) + msg + receiveid(智能机器人场景为空)
    const msgLen = decrypted.readUInt32BE(16);
    const msg = decrypted.subarray(20, 20 + msgLen);
    return msg.toString("utf8");
  }

  /** 生成签名:SHA1(sort([token, timestamp, nonce, encrypt]).join("")) */
  sign(timestamp: string, nonce: string, encrypted: string): string {
    const arr = [this.token, timestamp, nonce, encrypted].sort();
    return createHash("sha1").update(arr.join("")).digest("hex");
  }

  /** 校验签名 */
  verifySign(timestamp: string, nonce: string, encrypted: string, signature: string): boolean {
    return this.sign(timestamp, nonce, encrypted) === signature;
  }
}
