import Redis from "ioredis";

// 锁 TTL(秒),略小于执行超时,防崩溃锁不释放
const LOCK_TTL = 120;
// msgId 去重 TTL(秒)
const DEDUP_TTL = 300;

export interface RedisLike {
  hset(key: string, field: string, value: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  setnx(key: string, value: string): Promise<number>;
  del(key: string): Promise<number>;
  expire(key: string, ttl: number): Promise<number>;
  // 原子 SET key val EX ttl NX:对应 Redis SET key val EX ttl NX,返回 "OK"(成功)或 null(键存在,NX 失败)
  // 使用 ioredis 标准位置参数签名(非对象),确保生产环境与真实 ioredis 兼容
  set(key: string, value: string, expiryMode: "EX", seconds: number, setMode: "NX"): Promise<string | null>;
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
}

// 工厂:从 url 创建真实 ioredis 实例
export function createRedis(url: string): Redis {
  return new Redis(url);
}
