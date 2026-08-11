import { describe, it, expect, vi } from "vitest";
import { SessionRouter } from "../../src/router/session-router.js";
import type { SessionStore } from "../../src/store/redis.js";
import type { NormalizedMessage } from "../../src/im/types.js";

// 假 store:记录 setStreamChunk 调用(覆盖式,最后一次是最终内容)
function fakeStore(opts: { duplicate?: boolean; lockBusy?: boolean; sessions?: Map<string, string> } = {}) {
  const sessions = opts.sessions ?? new Map<string, string>();
  const streamChunks: { streamId: string; content: string; finish: boolean }[] = [];
  return {
    sessions,
    streamChunks,
    async getSession(k: string) { return sessions.has(k) ? { sessionId: sessions.get(k)! } : null; },
    async setSession(k: string, sid: string) { sessions.set(k, sid); },
    async tryAcquireLock() { return !opts.lockBusy; },
    async releaseLock() {},
    async isDuplicate() { return opts.duplicate ?? false; },
    async setStreamChunk(streamId: string, content: string, finish: boolean) {
      streamChunks.push({ streamId, content, finish });
    },
    async getStreamState() { return null; },
  } as any as SessionStore & { streamChunks: { streamId: string; content: string; finish: boolean }[] };
}

function mkMsg(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { botId: "wecom_1", msgId: "m1", chatSceneId: "p2p:zhangsan", userId: "zhangsan", text: "hi", ...over };
}

describe("SessionRouter", () => {
  it("首次消息:新建会话回写 sessionId,流式推送 final(最后 finish=true)", async () => {
    const store = fakeStore();
    let receivedProjectDir: string | undefined;
    const fakeAdapter = {
      async start(o: any) {
        receivedProjectDir = o.projectDir;
        return {
          sessionId: "sid-new",
          async *send() { yield { type: "final", text: "回复内容" }; },
          kill() {},
        };
      },
    };
    const router = new SessionRouter({
      store, getAdapter: () => fakeAdapter as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true,
    });
    await router.handle(mkMsg(), "stream-1");
    expect(store.sessions.get("wecom_1:p2p:zhangsan:zhangsan:claude")).toBe("sid-new");
    expect(receivedProjectDir).toBe("/tmp/proj");
    // 流式:应有 chunk(中间 finish=false)+ 最终(finish=true)
    expect(store.streamChunks.length).toBeGreaterThanOrEqual(1);
    const last = store.streamChunks[store.streamChunks.length - 1];
    expect(last.finish).toBe(true);
    expect(last.content).toContain("回复内容");
  });

  it("白名单外用户:回无权限(finish=true),不执行 CLI", async () => {
    const store = fakeStore();
    const started = vi.fn();
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start() { started(); return { async *send(){}, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => false,
    });
    await router.handle(mkMsg(), "s");
    expect(started).not.toHaveBeenCalled();
    expect(store.streamChunks[0].content).toBe("无权限使用该机器人");
    expect(store.streamChunks[0].finish).toBe(true);
  });

  it("锁占用:回上一条处理中(finish=true),不启动 CLI", async () => {
    const store = fakeStore({ lockBusy: true });
    const started = vi.fn();
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start() { started(); return { async *send(){}, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true,
    });
    await router.handle(mkMsg(), "s");
    expect(started).not.toHaveBeenCalled();
    expect(store.streamChunks[0].content).toContain("处理中");
  });

  it("resume:已有 session 时 adapter.start 收到 sessionId", async () => {
    const store = fakeStore({ sessions: new Map([["wecom_1:p2p:zhangsan:zhangsan:claude", "sid-old"]]) });
    let receivedSid: string | undefined;
    const router = new SessionRouter({
      store, getAdapter: () => ({
        async start(o: any) { receivedSid = o.sessionId; return { sessionId: "sid-old", async *send(){ yield {type:"final",text:"x"}; }, kill(){} }; },
      }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true,
    });
    await router.handle(mkMsg(), "s");
    expect(receivedSid).toBe("sid-old");
  });

  it("@codex 前缀:Key 的 cliType 为 codex", async () => {
    const store = fakeStore();
    let adapterType = "";
    const getAdapter = (t: any) => { adapterType = t; return { async start(){ return { sessionId:"sid-codex", async *send(){ yield {type:"final",text:"x"}; }, kill(){} }; } }; };
    const router = new SessionRouter({
      store, getAdapter: getAdapter as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, cliSwitchPrefix: "@", isAllowed: () => true,
    });
    await router.handle(mkMsg({ text: "@codex 重构一下" }), "s");
    expect(adapterType).toBe("codex");
    expect(store.sessions.has("wecom_1:p2p:zhangsan:zhangsan:codex")).toBe(true);
  });

  it("去重:重复消息回'消息已处理'不执行 CLI", async () => {
    const store = fakeStore({ duplicate: true });
    const started = vi.fn();
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start() { started(); return { async *send(){}, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true,
    });
    await router.handle(mkMsg(), "s");
    expect(started).not.toHaveBeenCalled();
    expect(store.streamChunks[0].content).toBe("消息已处理");
  });

  it("流式:多个 final chunk 实时推送累积内容(覆盖式)", async () => {
    const store = fakeStore();
    const fakeAdapter = {
      async start() {
        return {
          sessionId: "sid",
          async *send() {
            yield { type: "final", text: "第一" };
            yield { type: "final", text: "第二" };
          },
          kill() {},
        };
      },
    };
    const router = new SessionRouter({
      store, getAdapter: () => fakeAdapter as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true,
    });
    await router.handle(mkMsg(), "stream-multi");
    // 应有 3 次推送:chunk1 "第一"(finish=false)、chunk2 "第一第二"(finish=false)、最终(finish=true)
    const contents = store.streamChunks.map((c) => c.content);
    expect(contents).toContain("第一");
    expect(contents).toContain("第一第二");
    const last = store.streamChunks[store.streamChunks.length - 1];
    expect(last.finish).toBe(true);
    expect(last.content).toBe("第一第二");
  });

  it("群聊隔离:同群不同用户 Key 不同,session 各自独立", async () => {
    const store = fakeStore();
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start(){ return { sessionId:"s", async *send(){ yield {type:"final",text:"ok"}; }, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true,
    });
    await router.handle(mkMsg({ chatSceneId: "group:g1", userId: "alice", msgId: "a1" }), "sa");
    await router.handle(mkMsg({ chatSceneId: "group:g1", userId: "bob", msgId: "b1" }), "sb");
    expect(store.sessions.has("wecom_1:group:g1:alice:claude")).toBe(true);
    expect(store.sessions.has("wecom_1:group:g1:bob:claude")).toBe(true);
  });

  it("adapter.start 失败:回'claude 启动失败'(finish=true)", async () => {
    const store = fakeStore();
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start(){ throw new Error("boom"); } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true,
    });
    await router.handle(mkMsg(), "s");
    expect(store.streamChunks[0].content).toContain("启动失败");
    expect(store.streamChunks[0].finish).toBe(true);
  });

  it("携带 responseUrl 且正常完成:调用 sendActiveReply 主动推送最终内容", async () => {
    const store = fakeStore();
    const sendActiveReply = vi.fn(async () => {});
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start(){ return { sessionId:"s", async *send(){ yield {type:"final",text:"最终结果"}; }, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true,
      sendActiveReply,
    });
    await router.handle(mkMsg({ responseUrl: "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=abc" }), "stream-r");
    expect(sendActiveReply).toHaveBeenCalledTimes(1);
    const [msg, content] = sendActiveReply.mock.calls[0];
    expect(msg.responseUrl).toBe("https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=abc");
    expect(content).toContain("最终结果");
  });

  it("无 responseUrl:不调用 sendActiveReply", async () => {
    const store = fakeStore();
    const sendActiveReply = vi.fn(async () => {});
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start(){ return { sessionId:"s", async *send(){ yield {type:"final",text:"ok"}; }, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true,
      sendActiveReply,
    });
    await router.handle(mkMsg(), "s");
    expect(sendActiveReply).not.toHaveBeenCalled();
  });
});
