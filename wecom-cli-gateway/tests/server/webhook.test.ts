import { describe, it, expect, vi } from "vitest";
import { createApp } from "../../src/server/app.js";

describe("webhook", () => {
  it("POST /webhook/wecom/wecom_1 立即返回 success", async () => {
    const handle = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      parseMessage: async () => ({ botId: "wecom_1", msgId: "m1", chatSceneId: "p2p:u", userId: "u", text: "hi" }),
      routerHandle: handle,
    });
    const res = await app.inject({ method: "POST", url: "/webhook/wecom/wecom_1", payload: "enc" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "success" });
    // handle 被异步调用(不阻塞响应)
    expect(handle).toHaveBeenCalled();
  });

  it("parseMessage 收到 inject 的 payload body", async () => {
    let receivedBody: Buffer | undefined;
    const handle = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      parseMessage: async (body) => { receivedBody = body; return { botId: "wecom_1", msgId: "m1", chatSceneId: "p2p:u", userId: "u", text: "hi" }; },
      routerHandle: handle,
    });
    await app.inject({ method: "POST", url: "/webhook/wecom/wecom_1", payload: "encrypted-payload-data" });
    // 等 .then() 微任务完成
    await new Promise((r) => setTimeout(r, 50));
    expect(receivedBody?.toString("utf8")).toBe("encrypted-payload-data");
  });
});
