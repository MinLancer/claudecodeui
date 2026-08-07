import { describe, it, expect, vi } from "vitest";
import { SessionRouter } from "../../src/router/session-router.js";
import type { SessionStore } from "../../src/store/redis.js";
import type { NormalizedMessage } from "../../src/im/types.js";

// 假 store
function fakeStore(): SessionStore & { sessions: Map<string, string> } {
  const sessions = new Map<string, string>();
  return {
    sessions,
    async getSession(k) { return sessions.has(k) ? { sessionId: sessions.get(k)! } : null; },
    async setSession(k, sid) { sessions.set(k, sid); },
    async tryAcquireLock() { return true; },
    async releaseLock() {},
    async isDuplicate() { return false; },
  } as any;
}

function mkMsg(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { botId: "wecom_1", msgId: "m1", chatSceneId: "p2p:zhangsan", userId: "zhangsan", text: "hi", ...over };
}

describe("SessionRouter", () => {
  it("首次消息:新建会话并回写 sessionId,推送 final", async () => {
    const store = fakeStore();
    const replies: string[] = [];
    let receivedProjectDir: string | undefined;
    const fakeAdapter = {
      async start(o: any) {
        receivedProjectDir = o.projectDir;
        return {
          sessionId: "sid-new",
          async *send(_t: string) { yield { type: "final", text: "回复内容" }; },
          kill() {},
        };
      },
    };
    const router = new SessionRouter({
      store,
      getAdapter: () => fakeAdapter,
      defaultCli: "claude",
      projectDir: "/tmp/proj",
      timeoutSec: 180,
      onReply: async (text) => { replies.push(text); },
      isAllowed: () => true,
    });
    await router.handle(mkMsg());
    expect(store.sessions.get("wecom_1:p2p:zhangsan:zhangsan:claude")).toBe("sid-new");
    expect(receivedProjectDir).toBe("/tmp/proj");
    expect(replies.join("")).toContain("回复内容");
  });

  it("白名单外用户:回无权限,不执行", async () => {
    const store = fakeStore();
    const started = vi.fn();
    const router = new SessionRouter({
      store,
      getAdapter: () => ({ async start() { started(); return { async *send(){}, kill(){} }; } }),
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180,
      onReply: async () => {},
      isAllowed: () => false,
    });
    await router.handle(mkMsg());
    expect(started).not.toHaveBeenCalled();
  });

  it("锁占用:回上一条处理中,不启动 CLI", async () => {
    const store = fakeStore();
    let lockBusy = true;
    store.tryAcquireLock = async () => !lockBusy;
    const started = vi.fn();
    const router = new SessionRouter({
      store,
      getAdapter: () => ({ async start() { started(); return { async *send(){}, kill(){} }; } }),
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180,
      onReply: async (t) => { expect(t).toContain("处理中"); },
      isAllowed: () => true,
    });
    await router.handle(mkMsg());
    expect(started).not.toHaveBeenCalled();
  });

  it("resume:已有 session 时 adapter.start 收到 sessionId", async () => {
    const store = fakeStore();
    store.sessions.set("wecom_1:p2p:zhangsan:zhangsan:claude", "sid-old");
    let receivedSid: string | undefined;
    const router = new SessionRouter({
      store,
      getAdapter: () => ({
        async start(o: any) { receivedSid = o.sessionId; return { sessionId: "sid-old", async *send(){ yield {type:"final",text:"x"}; }, kill(){} }; },
      }),
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180,
      onReply: async () => {},
      isAllowed: () => true,
    });
    await router.handle(mkMsg());
    expect(receivedSid).toBe("sid-old");
  });

  it("@codex 前缀:Key 的 cliType 为 codex", async () => {
    const store = fakeStore();
    let adapterType = "";
    const router = new SessionRouter({
      store,
      getAdapter: (t) => { adapterType = t; return { async start(){ return { sessionId: "sid-codex", async *send(){ yield {type:"final",text:"x"}; }, kill(){} }; } }; },
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, cliSwitchPrefix: "@",
      onReply: async () => {},
      isAllowed: () => true,
    });
    await router.handle(mkMsg({ text: "@codex 重构一下" }));
    expect(adapterType).toBe("codex");
    // Key 含 codex
    expect(store.sessions.has("wecom_1:p2p:zhangsan:zhangsan:codex")).toBe(true);
  });

  // C2 补测试
  it("store.isDuplicate 抛错时回服务暂时不可用,不执行 CLI", async () => {
    const store = fakeStore();
    store.isDuplicate = async () => { throw new Error("redis down"); };
    const started = vi.fn();
    const replies: string[] = [];
    const router = new SessionRouter({
      store,
      getAdapter: () => ({ async start() { started(); return { async *send(){}, kill(){} }; } }),
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180,
      onReply: async (t) => { replies.push(t); },
      isAllowed: () => true,
    });
    await router.handle(mkMsg());
    expect(started).not.toHaveBeenCalled();
    expect(replies.join("")).toContain("服务暂时不可用");
  });

  it("adapter.start 抛错时回启动失败并释放锁", async () => {
    const store = fakeStore();
    let lockReleased = false;
    store.releaseLock = async () => { lockReleased = true; };
    const replies: string[] = [];
    const router = new SessionRouter({
      store,
      getAdapter: () => ({ async start() { throw new Error("cli crash"); } }),
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180,
      onReply: async (t) => { replies.push(t); },
      isAllowed: () => true,
    });
    await router.handle(mkMsg());
    expect(replies.join("")).toContain("启动失败");
    expect(lockReleased).toBe(true);
  });

  // I6 补测试
  it("群聊隔离:同群不同用户 Key 不同,session 各自独立", async () => {
    const store = fakeStore();
    let n = 0;
    const router = new SessionRouter({
      store,
      getAdapter: () => ({
        async start(o: any) {
          n++;
          return { sessionId: o.sessionId ?? `sid-${n}`, async *send(){ yield {type:"final",text:"ok"}; }, kill(){} };
        },
      }),
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180,
      onReply: async () => {},
      isAllowed: () => true,
    });
    // 同群(group:room1)两用户
    await router.handle(mkMsg({ chatSceneId: "group:room1", userId: "alice", msgId: "m-a" }));
    await router.handle(mkMsg({ chatSceneId: "group:room1", userId: "bob", msgId: "m-b" }));
    // Key 不同
    expect(store.sessions.has("wecom_1:group:room1:alice:claude")).toBe(true);
    expect(store.sessions.has("wecom_1:group:room1:bob:claude")).toBe(true);
    // session 各自独立
    expect(store.sessions.get("wecom_1:group:room1:alice:claude")).not.toBe(
      store.sessions.get("wecom_1:group:room1:bob:claude")
    );
  });

  it("去重:同一 msgId 重复消息不启动 CLI", async () => {
    const store = fakeStore();
    let dup = false;
    store.isDuplicate = async () => dup;
    const started = vi.fn();
    const router = new SessionRouter({
      store,
      getAdapter: () => ({ async start() { started(); return { sessionId:"s", async *send(){ yield {type:"final",text:"x"}; }, kill(){} }; } }),
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180,
      onReply: async () => {},
      isAllowed: () => true,
    });
    await router.handle(mkMsg({ msgId: "dup-1" }));
    expect(started).toHaveBeenCalledTimes(1);
    // 第二次同一 msgId 视为重复
    dup = true;
    await router.handle(mkMsg({ msgId: "dup-1" }));
    expect(started).toHaveBeenCalledTimes(1);
  });
});
