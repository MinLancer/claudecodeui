import { describe, it, expect, vi } from "vitest";
import { createApp } from "../../src/server/app.js";

// 辅助:构造一个带所有流式依赖的 app
function makeApp(overrides: Partial<{
  parseMessage: any;
  handleUserMessage: any;
  getStreamState: any;
  buildStreamResponse: any;
}> = {}) {
  const handleUserMessage = overrides.handleUserMessage ?? vi.fn().mockResolvedValue("sid");
  const getStreamState = overrides.getStreamState ?? vi.fn().mockResolvedValue(null);
  const buildStreamResponse = overrides.buildStreamResponse ?? vi.fn().mockImplementation(
    async (streamId: string, content: string, finish: boolean) =>
      JSON.stringify({ streamId, content, finish }),
  );
  const app = createApp({
    parseMessage: overrides.parseMessage ?? (async () => ({
      botId: "wecom_1", msgId: "m1", chatSceneId: "p2p:u", userId: "u", text: "hi",
    })),
    handleUserMessage,
    getStreamState,
    buildStreamResponse,
  });
  return { app, handleUserMessage, getStreamState, buildStreamResponse };
}

describe("webhook", () => {
  it("用户消息 POST:异步触发 handleUserMessage,同步返回流式首响应", async () => {
    const { app, handleUserMessage, buildStreamResponse } = makeApp();
    const res = await app.inject({
      method: "POST", url: "/webhook/wecom/wecom_1",
      payload: JSON.stringify({ encrypt: "x" }),
      headers: { "content-type": "application/json", nonce: "n1" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.finish).toBe(false); // 首响应 finish=false
    expect(body.content).toBe(""); // 首响应 content 空
    expect(handleUserMessage).toHaveBeenCalled(); // 异步触发
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

  it("流式刷新回调:getStreamState 无数据时返回 finish=true 空响应", async () => {
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
    expect(body.finish).toBe(true);
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
