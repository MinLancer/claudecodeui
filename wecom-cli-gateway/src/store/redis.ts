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
    const ok = await this.redis.setnx(`lock:${key}`, "1");
    if (ok === 1) {
      await this.redis.expire(`lock:${key}`, ttlSec);
      return true;
    }
    return false;
  }

  async releaseLock(key: string): Promise<void> {
    await this.redis.del(`lock:${key}`);
  }

  async isDuplicate(msgId: string): Promise<boolean> {
    const ok = await this.redis.setnx(`msgdedup:${msgId}`, "1");
    if (ok === 1) {
      await this.redis.expire(`msgdedup:${msgId}`, DEDUP_TTL);
      return false;
    }
    return true;
  }
}

// 工厂:从 url 创建真实 ioredis 实例
export function createRedis(url: string): Redis {
  return new Redis(url);
}
