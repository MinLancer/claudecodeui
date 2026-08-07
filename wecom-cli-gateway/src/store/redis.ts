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
  // 原子 SET NX EX:对应 Redis SET key val NX EX ttl,成功返回 "OK",键存在返回 null
  set(key: string, value: string, opts: { mode: "NX"; ttl: number }): Promise<string | null>;
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
    // 原子操作:SET NX EX,避免 setnx+expire 两步的崩溃窗口
    const res = await this.redis.set(`lock:${key}`, "1", { mode: "NX", ttl: ttlSec });
    return res === "OK";
  }

  async releaseLock(key: string): Promise<void> {
    await this.redis.del(`lock:${key}`);
  }

  async isDuplicate(msgId: string): Promise<boolean> {
    // 原子操作:SET NX EX,成功(首次)返回 false(非重复),键存在返回 true(重复)
    const res = await this.redis.set(`msgdedup:${msgId}`, "1", { mode: "NX", ttl: DEDUP_TTL });
    return res === null;
  }
}

// 工厂:从 url 创建真实 ioredis 实例
export function createRedis(url: string): Redis {
  return new Redis(url);
}
