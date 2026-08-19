import { describe, it, expect, vi } from "vitest";
import { SessionRouter } from "../../src/router/session-router.js";
import type { SessionStore } from "../../src/store/redis.js";
import type { NormalizedMessage } from "../../src/im/types.js";

// 假 store:记录 setStreamChunk 调用(覆盖式,最后一次是最终内容)
function fakeStore(opts: { duplicate?: boolean; lockBusy?: boolean; sessions?: Map<string, string> } = {}) {
  const sessions = opts.sessions ?? new Map<string, string>();
  const streamChunks: { streamId: string; content: string; finish: boolean }[] = [];
  const deletedKeys: string[] = [];
  const dailyClear = new Map<string, string>();
  return {
    sessions,
    streamChunks,
    deletedKeys,
    dailyClear,
    async getSession(k: string) { return sessions.has(k) ? { sessionId: sessions.get(k)! } : null; },
    async setSession(k: string, sid: string) { sessions.set(k, sid); },
    async deleteSession(k: string) { deletedKeys.push(k); },
    async tryAcquireLock() { return !opts.lockBusy; },
    async releaseLock() {},
    async isDuplicate() { return opts.duplicate ?? false; },
    async setStreamChunk(streamId: string, content: string, finish: boolean) {
      streamChunks.push({ streamId, content, finish });
    },
    async getStreamState() { return null; },
    async getDailyClear(k: string) { return dailyClear.has(k) ? dailyClear.get(k)! : null; },
    async setDailyClear(k: string, date: string) { dailyClear.set(k, date); },
  } as any as SessionStore & {
    streamChunks: { streamId: string; content: string; finish: boolean }[];
    deletedKeys: string[];
    dailyClear: Map<string, string>;
  };
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
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true, finishDelayMs: 5,
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
    // 企微被动流式对过短内容不上屏,短回复须被加长到安全长度
    expect(store.streamChunks[0].content).toContain("无权限使用该机器人");
    expect(store.streamChunks[0].content.length).toBeGreaterThanOrEqual(200);
    expect(store.streamChunks[0].finish).toBe(true);
  });

  it("锁占用:回上一条处理中(finish=true),不启动 CLI", async () => {
    const store = fakeStore({ lockBusy: true });
    const started = vi.fn();
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start() { started(); return { async *send(){}, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true, finishDelayMs: 5,
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
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true, finishDelayMs: 5,
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
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, cliSwitchPrefix: "@", isAllowed: () => true, finishDelayMs: 5,
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
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true, finishDelayMs: 5,
    });
    await router.handle(mkMsg(), "s");
    expect(started).not.toHaveBeenCalled();
    expect(store.streamChunks[0].content).toContain("消息已处理");
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
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true, finishDelayMs: 5,
    });
    await router.handle(mkMsg(), "stream-multi");
    // 应有 3 次推送:chunk1 "第一"(finish=false)、chunk2 "第一第二"(finish=false)、最终(finish=true)
    // 注:短内容会被 ensureDisplayable 加长,故用 includes 而非精确匹配
    const contents = store.streamChunks.map((c) => c.content);
    expect(contents.some((c) => c.includes("第一"))).toBe(true);
    expect(contents.some((c) => c.includes("第一第二"))).toBe(true);
    const last = store.streamChunks[store.streamChunks.length - 1];
    expect(last.finish).toBe(true);
    expect(last.content).toContain("第一第二");
  });

  it("群聊隔离:同群不同用户 Key 不同,session 各自独立", async () => {
    const store = fakeStore();
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start(){ return { sessionId:"s", async *send(){ yield {type:"final",text:"ok"}; }, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true, finishDelayMs: 5,
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
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true, finishDelayMs: 5,
    });
    await router.handle(mkMsg(), "s");
    expect(store.streamChunks[0].content).toContain("启动失败");
    expect(store.streamChunks[0].finish).toBe(true);
  });

  it("快速完成(未触发安抚)+ responseUrl:不调用 sendActiveReply(被动流式已送达)", async () => {
    const store = fakeStore();
    const sendActiveReply = vi.fn(async () => {});
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start(){ return { sessionId:"s", async *send(){ yield {type:"final",text:"最终结果"}; }, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true, finishDelayMs: 5,
      sendActiveReply, reassureSec: 10,
    });
    await router.handle(mkMsg({ responseUrl: "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=abc" }), "stream-r");
    expect(sendActiveReply).not.toHaveBeenCalled();
  });

  it("触发安抚(超 reassureSec)后完成:调用 sendActiveReply 主动推送", async () => {
    const store = fakeStore();
    const sendActiveReply = vi.fn(async () => {});
    let releaseSend: (() => void) | undefined;
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start(){ return { sessionId:"s", async *send(){ await new Promise<void>(r => { releaseSend = r; }); yield {type:"final",text:"最终结果"}; }, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 600, isAllowed: () => true, finishDelayMs: 5,
      sendActiveReply, reassureSec: 1,
    });
    const done = router.handle(mkMsg({ responseUrl: "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=abc" }), "stream-r");
    await new Promise((r) => setTimeout(r, 1500)); // 触发安抚
    releaseSend?.();
    await done;
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
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 180, isAllowed: () => true, finishDelayMs: 5,
      sendActiveReply,
    });
    await router.handle(mkMsg(), "s");
    expect(sendActiveReply).not.toHaveBeenCalled();
  });

  it("claude 处理超过 reassureSec 时推安抚消息'请您稍后'(finish=true,让企微显示)", async () => {
    const store = fakeStore();
    let releaseSend: (() => void) | undefined;
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start(){ return { sessionId:"s", async *send(){ await new Promise<void>(r => { releaseSend = r; }); }, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 600, isAllowed: () => true, finishDelayMs: 5,
      reassureSec: 1,
    });
    const done = router.handle(mkMsg(), "stream-r");
    // 等待超过 reassureSec(1s),安抚应已推送
    await new Promise((r) => setTimeout(r, 1500));
    const reassureFrame = store.streamChunks.find((c) => c.content.includes("请您稍后"));
    expect(reassureFrame).toBeTruthy();
    // 企微被动流式只显示 finish=true 的内容,安抚须 finish=true 才能上屏
    expect(reassureFrame!.finish).toBe(true);
    releaseSend?.();
    await done;
  });

  it("claude 快速完成时不推安抚消息", async () => {
    const store = fakeStore();
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start(){ return { sessionId:"s", async *send(){ yield {type:"final",text:"ok"}; }, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 600, isAllowed: () => true, finishDelayMs: 5,
      reassureSec: 10,
    });
    await router.handle(mkMsg(), "s");
    expect(store.streamChunks.some((c) => c.content.includes("请您稍后"))).toBe(false);
  });

  it("/clear:删除该用户所有 cliType 会话,回'上下文已清空'(finish=true),不启动 CLI", async () => {
    const store = fakeStore({ sessions: new Map([["wecom_1:p2p:zhangsan:zhangsan:claude", "sid-old"]]) });
    const started = vi.fn();
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start(){ started(); return { sessionId:"s", async *send(){}, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 600, isAllowed: () => true, finishDelayMs: 5,
      clearDelayMs: 5,
    });
    await router.handle(mkMsg({ text: "/clear" }), "s");
    // 4 个 cliType 的 key 都被删
    expect(store.deletedKeys).toEqual([
      "wecom_1:p2p:zhangsan:zhangsan:claude",
      "wecom_1:p2p:zhangsan:zhangsan:codex",
      "wecom_1:p2p:zhangsan:zhangsan:cursor",
      "wecom_1:p2p:zhangsan:zhangsan:opencode",
    ]);
    expect(started).not.toHaveBeenCalled();
    const last = store.streamChunks[store.streamChunks.length - 1];
    expect(last.content).toContain("上下文已清空");
    expect(last.finish).toBe(true);
  });

  it("中文命令'清空上下文'同样触发清空", async () => {
    const store = fakeStore();
    const started = vi.fn();
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start(){ started(); return { sessionId:"s", async *send(){}, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 600, isAllowed: () => true, finishDelayMs: 5,
      clearDelayMs: 5,
    });
    await router.handle(mkMsg({ text: "清空上下文" }), "s");
    expect(started).not.toHaveBeenCalled();
    expect(store.deletedKeys.length).toBe(4);
    expect(store.streamChunks[store.streamChunks.length - 1].content).toContain("上下文已清空");
  });

  it("/clear:先推内容(finish=false)让企微进入流式展示,再延时后标记完成(finish=true)", async () => {
    const store = fakeStore();
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start(){ return { sessionId:"s", async *send(){}, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 600, isAllowed: () => true, finishDelayMs: 5,
      clearDelayMs: 5,
    });
    await router.handle(mkMsg({ text: "/clear" }), "s");
    // 企微被动流式要求:内容非空但 finish=false 的中间帧(进入流式展示) -> 之后 finish=true
    const contentFrames = store.streamChunks.filter((c) => c.content.includes("上下文已清空"));
    expect(contentFrames.length).toBeGreaterThanOrEqual(2);
    expect(contentFrames[0].finish).toBe(false);
    expect(contentFrames[contentFrames.length - 1].finish).toBe(true);
  });

  it("进入会话(enter_chat):当天首次清空全部 cliType 会话并返回默认欢迎语", async () => {
    const store = fakeStore({ sessions: new Map([["wecom_1:p2p:zhangsan:zhangsan:claude", "sid-old"]]) });
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start(){ return { sessionId:"s", async *send(){}, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 600, isAllowed: () => true, finishDelayMs: 5,
    });
    const greeting = await router.handleEnterChat(mkMsg({ eventType: "enter_chat", text: "" }));
    expect(greeting).toContain("今天本大虾");
    // 4 个 cliType 的 key 都被删(与 /clear 一致)
    expect(store.deletedKeys).toEqual([
      "wecom_1:p2p:zhangsan:zhangsan:claude",
      "wecom_1:p2p:zhangsan:zhangsan:codex",
      "wecom_1:p2p:zhangsan:zhangsan:cursor",
      "wecom_1:p2p:zhangsan:zhangsan:opencode",
    ]);
    // 当天再次进入不再清空、不再回复
    const second = await router.handleEnterChat(mkMsg({ eventType: "enter_chat", text: "", msgId: "m2" }));
    expect(second).toBeNull();
    expect(store.deletedKeys.length).toBe(4);
  });

  it("进入会话(enter_chat):配置 enterGreeting 时返回自定义欢迎语", async () => {
    const store = fakeStore();
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start(){ return { sessionId:"s", async *send(){}, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 600, isAllowed: () => true, finishDelayMs: 5,
      enterGreeting: "欢迎使用!",
    });
    const greeting = await router.handleEnterChat(mkMsg({ eventType: "enter_chat", text: "" }));
    expect(greeting).toBe("欢迎使用!");
  });

  it("普通消息不触发清空(仍启动 CLI)", async () => {
    const store = fakeStore();
    const started = vi.fn();
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start(){ started(); return { sessionId:"s", async *send(){ yield {type:"final",text:"ok"}; }, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 600, isAllowed: () => true, finishDelayMs: 5,
    });
    await router.handle(mkMsg({ text: "你好" }), "s");
    expect(started).toHaveBeenCalled();
    expect(store.deletedKeys.length).toBe(0);
  });

  it("一次性输出:完成前延时(finishDelayMs),内容帧先于完成帧", async () => {
    // 一次性输出(claude 立即给完整回复)时,若无延时,内容帧与 finish=true 几乎同时发生,
    // 企微刷不到内容帧而不认完成。故完成前应等待 finishDelayMs(finish=true 延后)。
    vi.useFakeTimers();
    const store = fakeStore();
    const router = new SessionRouter({
      store, getAdapter: () => ({ async start(){ return { sessionId:"s", async *send(){ yield {type:"final",text:"一次性回复"}; }, kill(){} }; } }) as any,
      defaultCli: "claude", projectDir: "/tmp/proj", timeoutSec: 600, isAllowed: () => true, finishDelayMs: 5,
      reassureSec: 99999,
    });
    const done = router.handle(mkMsg(), "s");
    // 推进微任务(不推进延时 timer):内容帧(finish=false)已推送,但完成帧尚未发生
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.streamChunks.some((f) => f.content.includes("一次性回复") && !f.finish)).toBe(true);
    expect(store.streamChunks.some((f) => f.finish)).toBe(false);
    // 推进过 finishDelayMs 后完成
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(store.streamChunks[store.streamChunks.length - 1].finish).toBe(true);
    vi.useRealTimers();
  });
});
