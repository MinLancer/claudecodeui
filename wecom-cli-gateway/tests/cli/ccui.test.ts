import { describe, it, expect } from "vitest";
import { CcuiSession, type FetchSseFn } from "../../src/cli/ccui.js";

// 把若干 SSE 事件序列化为 Buffer 流(模拟 /api/agent 响应)
function sse(...events: object[]): Buffer {
  return Buffer.concat(events.map((e) => Buffer.from(`data: ${JSON.stringify(e)}\n\n`)));
}

function fakeFetchSse(events: object[]): FetchSseFn {
  return async function* () {
    yield sse(...events);
  };
}

describe("CcuiSession", () => {
  it("完整流:捕获 sessionId 并 yield final 文本", async () => {
    const session = new CcuiSession({
      baseUrl: "http://x", apiKey: "k", provider: "claude",
      projectDir: "/tmp/p", fetchSse: fakeFetchSse([
        { type: "status", message: "started" },
        { type: "session-id", sessionId: "sid-1" },
        { type: "claude-response", data: { type: "assistant", message: { content: [{ type: "text", text: "你好" }] } } },
        { type: "done" },
      ]),
      timeoutMs: 5000,
    });
    const chunks = [];
    for await (const c of session.send("hi")) chunks.push(c);
    expect(chunks).toEqual([{ type: "final", text: "你好" }]);
    expect(session.sessionId).toBe("sid-1");
  });

  it("error 事件 yield error chunk", async () => {
    const session = new CcuiSession({
      baseUrl: "http://x", apiKey: "k", provider: "claude", projectDir: "/tmp/p",
      fetchSse: fakeFetchSse([{ type: "error", error: "boom" }, { type: "done" }]),
      timeoutMs: 5000,
    });
    const chunks = [];
    for await (const c of session.send("hi")) chunks.push(c);
    expect(chunks).toEqual([{ type: "error", text: "boom" }]);
  });

  it("resume:传入 sessionId 时 body 含该字段", async () => {
    let capturedBody: any;
    const fetchSse: FetchSseFn = async function* (_url, init) {
      capturedBody = JSON.parse(init.body);
      yield sse({ type: "done" });
    };
    const session = new CcuiSession({
      baseUrl: "http://x", apiKey: "k", provider: "claude",
      projectDir: "/tmp/p", sessionId: "sid-old", fetchSse, timeoutMs: 5000,
    });
    for await (const _ of session.send("续")) { _; }
    expect(capturedBody.projectPath).toBe("/tmp/p");
    expect(capturedBody.provider).toBe("claude");
    expect(capturedBody.stream).toBe(true);
    expect(capturedBody.sessionId).toBe("sid-old");
    expect(capturedBody.message).toBe("续");
  });

  it("请求头含 x-api-key 与 content-type", async () => {
    let capturedHeaders: any;
    const fetchSse: FetchSseFn = async function* (_url, init) {
      capturedHeaders = init.headers;
      yield sse({ type: "done" });
    };
    const session = new CcuiSession({
      baseUrl: "http://x", apiKey: "key-123", provider: "claude",
      projectDir: "/tmp/p", fetchSse, timeoutMs: 5000,
    });
    for await (const _ of session.send("hi")) { _; }
    expect(capturedHeaders["x-api-key"]).toBe("key-123");
    expect(capturedHeaders["content-type"]).toBe("application/json");
  });

  it("url 为 baseUrl + /api/agent", async () => {
    let capturedUrl: string;
    const fetchSse: FetchSseFn = async function* (url) {
      capturedUrl = url;
      yield sse({ type: "done" });
    };
    const session = new CcuiSession({
      baseUrl: "http://localhost:3001", apiKey: "k", provider: "claude",
      projectDir: "/tmp/p", fetchSse, timeoutMs: 5000,
    });
    for await (const _ of session.send("hi")) { _; }
    expect(capturedUrl).toBe("http://localhost:3001/api/agent");
  });

  it("kill 中断后 send 迭代结束(已 yield 的 chunk 保留)", async () => {
    const session = new CcuiSession({
      baseUrl: "http://x", apiKey: "k", provider: "claude", projectDir: "/tmp/p",
      fetchSse: fakeFetchSse([
        { type: "claude-response", data: { type: "assistant", message: { content: [{ type: "text", text: "部分" }] } } },
        { type: "done" },
      ]),
      timeoutMs: 5000,
    });
    const chunks = [];
    for await (const c of session.send("hi")) {
      chunks.push(c);
      session.kill();
    }
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});
