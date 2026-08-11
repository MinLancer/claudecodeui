import Redis from "ioredis";

// 锁 TTL(秒),略小于执行超时,防崩溃锁不释放
const LOCK_TTL = 120;
// msgId 去重 TTL(秒)
const DEDUP_TTL = 300;
// 流式状态 TTL(秒),略大于企微流式 6 分钟超时
const STREAM_TTL = 400;

export interface RedisLike {
  hset(key: string, field: string, value: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  get(key: string): Promise<string | null>;
  setnx(key: string, value: string): Promise<number>;
  del(key: string): Promise<number>;
  expire(key: string, ttl: number): Promise<number>;
  // SET key val EX seconds [NX]:位置参数签名匹配真实 ioredis。
  // setMode 可选:省略时为普通 SET(覆盖,用于流式状态更新);"NX" 时仅键不存在才写(锁/去重)
  set(key: string, value: string, expiryMode: "EX", seconds: number, setMode?: "NX"): Promise<string | null>;
}

export class SessionStore {
  constructor(private redis: RedisLike) {}

  async getSession(key: string): Promise<{ sessionId: string } | null> {
    const sid = await this.redis.hget(`session:${key}`, "sessionId");
    return sid ? { sessionId: sid } : null;
  }

  async setSession(key: string, sessionId: string): Promise<void> {
    await this.redis.hset(`session:${key}`, "sessionId", sessionId);
  }

  async tryAcquireLock(key: string, ttlSec = LOCK_TTL): Promise<boolean> {
    // 原子操作:SET key val EX ttl NX,避免 setnx+expire 两步的崩溃窗口
    const res = await this.redis.set(`lock:${key}`, "1", "EX", ttlSec, "NX");
    return res === "OK";
  }

  async releaseLock(key: string): Promise<void> {
    await this.redis.del(`lock:${key}`);
  }

  async isDuplicate(msgId: string): Promise<boolean> {
    // 原子操作:SET key val EX ttl NX,首次(新建)返回 "OK"(非重复),键存在返回 null(重复)
    const res = await this.redis.set(`msgdedup:${msgId}`, "1", "EX", DEDUP_TTL, "NX");
    return res === null;
  }

  // 流式状态:覆盖式写最新 content + finish 标志(按 streamId)
  async setStreamChunk(streamId: string, content: string, finish: boolean): Promise<void> {
    const state = JSON.stringify({ content, finish });
    await this.redis.set(`stream:${streamId}`, state, "EX", STREAM_TTL);
  }

  // 流式状态:读取当前 content + finish
  async getStreamState(streamId: string): Promise<{ content: string; finish: boolean } | null> {
    const raw = await this.redis.get(`stream:${streamId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

// 工厂:从 url 创建真实 ioredis 实例
export function createRedis(url: string): Redis {
  return new Redis(url);
}
