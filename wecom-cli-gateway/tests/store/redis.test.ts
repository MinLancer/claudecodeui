import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore } from "../../src/store/redis.js";

// 用内存实现替代真实 redis;生产用 ioredis
class FakeRedis {
  private map = new Map<string, string>();
  private ttl = new Map<string, number>();
  async hset(key: string, field: string, val: string) { this.map.set(`${key}.${field}`, val); }
  async hget(key: string, field: string) { return this.map.get(`${key}.${field}`) ?? null; }
  async get(key: string) { return this.map.get(key) ?? null; }
  async setnx(key: string, val: string) { if (this.map.has(key)) return 0; this.map.set(key, val); return 1; }
  async del(key: string) { this.map.delete(key); this.ttl.delete(key); }
  async expire(key: string, ttl: number) { this.ttl.set(key, ttl); }
  // 模拟 Redis SET key val EX seconds NX:位置参数签名匹配真实 ioredis
  // NX 语义:键存在返回 null,不存在设置+记 TTL 返回 "OK"
  async set(key: string, val: string, expiryMode: "EX", seconds: number, setMode?: "NX"): Promise<string | null> {
    if (setMode === "NX" && this.map.has(key)) return null;
    this.map.set(key, val);
    this.ttl.set(key, seconds);
    return "OK";
  }
}

describe("SessionStore", () => {
  let store: SessionStore;
  let fake: FakeRedis;
  beforeEach(() => {
    fake = new FakeRedis();
    // 注入假 redis(构造函数接受任意 redis-like)
    store = new SessionStore(fake as any);
  });

  it("setSession 后 getSession 能取回", async () => {
    await store.setSession("k1", "sid-abc");
    const s = await store.getSession("k1");
    expect(s?.sessionId).toBe("sid-abc");
  });

  it("首次锁获取成功,再次失败", async () => {
    expect(await store.tryAcquireLock("k1", 120)).toBe(true);
    expect(await store.tryAcquireLock("k1", 120)).toBe(false);
  });

  it("释放锁后可重新获取", async () => {
    await store.tryAcquireLock("k1", 120);
    await store.releaseLock("k1");
    expect(await store.tryAcquireLock("k1", 120)).toBe(true);
  });

  it("同一 msgId 第二次判重", async () => {
    expect(await store.isDuplicate("m1")).toBe(false);
    expect(await store.isDuplicate("m1")).toBe(true);
  });

  it("流式状态:setStreamChunk 后 getStreamState 取回最新(覆盖式)", async () => {
    await store.setStreamChunk("s1", "部分1", false);
    let st = await store.getStreamState("s1");
    expect(st?.content).toBe("部分1");
    expect(st?.finish).toBe(false);
    await store.setStreamChunk("s1", "部分1部分2", false); // 覆盖式
    st = await store.getStreamState("s1");
    expect(st?.content).toBe("部分1部分2");
    expect(st?.finish).toBe(false);
  });

  it("流式状态:finish=true 后 getStreamState 反映完成", async () => {
    await store.setStreamChunk("s1", "最终回复", true);
    const st = await store.getStreamState("s1");
    expect(st?.content).toBe("最终回复");
    expect(st?.finish).toBe(true);
  });

  it("流式状态:无数据时 getStreamState 返回 null", async () => {
    const st = await store.getStreamState("nope");
    expect(st).toBeNull();
  });
});
