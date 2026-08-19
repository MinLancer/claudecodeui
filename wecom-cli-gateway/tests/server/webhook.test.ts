import { describe, it, expect, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { FIRST_REPLY_PLACEHOLDER } from "../../src/server/webhook.js";

// 辅助:构造一个带所有流式依赖的 app
function makeApp(overrides: Partial<{
  parseMessage: any;
  handleUserMessage: any;
  getStreamState: any;
  buildStreamResponse: any;
  handleEvent: any;
  buildTextResponse: any;
}> = {}) {
  const handleUserMessage = overrides.handleUserMessage ?? vi.fn().mockResolvedValue("sid");
  const getStreamState = overrides.getStreamState ?? vi.fn().mockResolvedValue(null);
  const buildStreamResponse = overrides.buildStreamResponse ?? vi.fn().mockImplementation(
    async (streamId: string, content: string, finish: boolean) =>
      JSON.stringify({ streamId, content, finish }),
  );
  const handleEvent = overrides.handleEvent ?? vi.fn().mockResolvedValue(null);
  const buildTextResponse = overrides.buildTextResponse ?? vi.fn().mockImplementation(
    async (content: string, nonce: string) => JSON.stringify({ msgtype: "text", content, nonce }),
  );
  const app = createApp({
    parseMessage: overrides.parseMessage ?? (async () => ({
      botId: "wecom_1", msgId: "m1", chatSceneId: "p2p:u", userId: "u", text: "hi",
    })),
    handleUserMessage,
    getStreamState,
    buildStreamResponse,
    handleEvent,
    buildTextResponse,
  });
  return { app, handleUserMessage, getStreamState, buildStreamResponse, handleEvent, buildTextResponse };
}

describe("webhook", () => {
  it("用户消息 POST:handleUserMessage 同步初始化+返回 streamId,同步返回流式首响应", async () => {
    const { app, handleUserMessage, buildStreamResponse } = makeApp();
    const res = await app.inject({
      method: "POST", url: "/webhook/wecom/wecom_1",
      payload: JSON.stringify({ encrypt: "x" }),
      headers: { "content-type": "application/json", nonce: "n1" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.finish).toBe(false); // 首响应 finish=false
    // 首响应返回非空占位内容,让企微端立即进入流式展示(避免空首帧长时间转圈超时)
    expect(body.content).toBe(FIRST_REPLY_PLACEHOLDER);
    expect(handleUserMessage).toHaveBeenCalled(); // 同步触发(含初始化)
    expect(buildStreamResponse).toHaveBeenCalled();
  });

  it("流式刷新回调 POST:getStreamState 返回最新 content+finish", async () => {
    const { app, getStreamState } = makeApp({
      parseMessage: async () => ({
        botId: "wecom_1", msgId: "", chatSceneId: "", userId: "", text: "", streamId: "stream-1",
      }),
      getStreamState: vi.fn().mockResolvedValue({ content: "部分回复", finish: false }),
    });
    const res = await app.inject({
      method: "POST", url: "/webhook/wecom/wecom_1",
      payload: JSON.stringify({ encrypt: "x" }),
      headers: { nonce: "n2" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content).toBe("部分回复");
    expect(body.finish).toBe(false);
    expect(getStreamState).toHaveBeenCalledWith("stream-1");
  });

  it("流式刷新回调:getStreamState 无数据时返回空 finish=false(让企微继续刷新)", async () => {
    const { app } = makeApp({
      parseMessage: async () => ({
        botId: "wecom_1", msgId: "", chatSceneId: "", userId: "", text: "", streamId: "gone",
      }),
      getStreamState: vi.fn().mockResolvedValue(null),
    });
    const res = await app.inject({
      method: "POST", url: "/webhook/wecom/wecom_1",
      payload: JSON.stringify({ encrypt: "x" }),
      headers: { nonce: "n3" },
    });
    const body = JSON.parse(res.body);
    expect(body.finish).toBe(false); // 不提前结束,让企微继续刷新等 router 写入
    expect(body.content).toBe("");
  });

  it("进入会话事件:handleEvent 返回欢迎语,用 buildTextResponse 被动文本回复", async () => {
    const handleEvent = vi.fn().mockResolvedValue("欢迎使用");
    const buildTextResponse = vi.fn().mockImplementation(
      async (content: string, nonce: string) => JSON.stringify({ msgtype: "text", content, nonce }),
    );
    const { app } = makeApp({
      parseMessage: async () => ({
        botId: "wecom_1", msgId: "me", chatSceneId: "p2p:u", userId: "u", text: "", eventType: "enter_chat",
      }),
      handleEvent, buildTextResponse,
    });
    const res = await app.inject({
      method: "POST", url: "/webhook/wecom/wecom_1",
      payload: JSON.stringify({ encrypt: "x" }),
      headers: { nonce: "n5" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.msgtype).toBe("text");
    expect(body.content).toBe("欢迎使用");
    expect(handleEvent).toHaveBeenCalled();
    expect(buildTextResponse).toHaveBeenCalledWith("欢迎使用", "n5");
  });

  it("进入会话事件:当天已清空(handleEvent 返回 null)时回 success 不回复", async () => {
    const handleEvent = vi.fn().mockResolvedValue(null);
    const buildTextResponse = vi.fn();
    const { app } = makeApp({
      parseMessage: async () => ({
        botId: "wecom_1", msgId: "me", chatSceneId: "p2p:u", userId: "u", text: "", eventType: "enter_chat",
      }),
      handleEvent, buildTextResponse,
    });
    const res = await app.inject({
      method: "POST", url: "/webhook/wecom/wecom_1",
      payload: JSON.stringify({ encrypt: "x" }),
      headers: { nonce: "n6" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "success" });
    expect(buildTextResponse).not.toHaveBeenCalled();
  });

  it("parseMessage 返回 null 时回 success", async () => {
    const { app } = makeApp({ parseMessage: async () => null });
    const res = await app.inject({
      method: "POST", url: "/webhook/wecom/wecom_1",
      payload: "garbage",
      headers: { nonce: "n4" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "success" });
  });
});
