import { describe, it, expect } from "vitest";
import { CcuiSession, CcuiAdapter, defaultFetchSse, type FetchSseFn } from "../../src/cli/ccui.js";

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

  it("claude 真实 SSE 格式(实证):status→session-id→kind:text→done", async () => {
    const session = new CcuiSession({
      baseUrl: "http://x", apiKey: "k", provider: "claude",
      projectDir: "/tmp/p", fetchSse: fakeFetchSse([
        { type: "status", message: "Session started" },
        { type: "session-id", sessionId: "sid-real" },
        { kind: "session_created", newSessionId: "sid-real" },
        { kind: "thinking", content: "思考中" },
        { kind: "status", text: "token_budget", tokenBudget: {} },
        { kind: "text", role: "assistant", content: "最终回复" },
        { kind: "complete", exitCode: 0, success: true },
        { type: "done" },
      ]),
      timeoutMs: 5000,
    });
    const chunks = [];
    for await (const c of session.send("hi")) chunks.push(c);
    expect(chunks).toEqual([{ type: "final", text: "最终回复" }]);
    expect(session.sessionId).toBe("sid-real");
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

describe("CcuiAdapter", () => {
  it("type 等于构造传入的 provider", () => {
    const a = new CcuiAdapter({ baseUrl: "http://x", apiKey: "k", provider: "codex", fetchSse: fakeFetchSse([]) });
    expect(a.type).toBe("codex");
  });

  it("isAvailable 返回 true(与其他 adapter 一致)", async () => {
    const a = new CcuiAdapter({ baseUrl: "http://x", apiKey: "k", provider: "claude", fetchSse: fakeFetchSse([]) });
    expect(await a.isAvailable()).toBe(true);
  });

  it("start 返回 CcuiSession 且 send 能拿到 final 文本", async () => {
    const a = new CcuiAdapter({
      baseUrl: "http://x", apiKey: "k", provider: "claude",
      fetchSse: fakeFetchSse([
        { type: "session-id", sessionId: "s9" },
        { type: "claude-response", data: { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } } },
        { type: "done" },
      ]),
      timeoutMs: 5000,
    });
    const session = await a.start({ projectDir: "/tmp/proj" });
    const chunks = [];
    for await (const c of session.send("hi")) chunks.push(c);
    expect(chunks).toEqual([{ type: "final", text: "ok" }]);
    expect(session.sessionId).toBe("s9");
  });

  it("start 携带 sessionId 时透传给 session", async () => {
    let capturedBody: any;
    const a = new CcuiAdapter({
      baseUrl: "http://x", apiKey: "k", provider: "claude",
      fetchSse: async function* (_u, init) { capturedBody = JSON.parse(init.body); yield sse({ type: "done" }); },
      timeoutMs: 5000,
    });
    const session = await a.start({ projectDir: "/tmp/p", sessionId: "sid-resume" });
    for await (const _ of session.send("go")) { _; }
    expect(capturedBody.sessionId).toBe("sid-resume");
  });

  it("defaultFetchSse 是函数(仅类型/存在性,不发真实网络)", () => {
    expect(typeof defaultFetchSse).toBe("function");
  });

  it("kill 在 fetchSse await 期间触发时不 yield 错误 chunk", async () => {
    // 模拟 reader.read() 挂起直到 abort:await 期间 kill 会触发 AbortError。
    const session = new CcuiSession({
      baseUrl: "http://x", apiKey: "k", provider: "claude", projectDir: "/tmp/p",
      fetchSse: async function* (_url, init) {
        // 等待 signal abort 后抛 AbortError,模拟真实 fetch reader.read()
        await new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
        });
      },
      timeoutMs: 5000,
    });
    const chunks = [];
    const iterator = session.send("hi");
    // 启动迭代,但在第一个 await 挂起时 kill
    const first = iterator.next();
    await Promise.resolve();
    session.kill();
    await first;
    for await (const c of iterator) chunks.push(c);
    expect(chunks).toEqual([]); // 不应有 error chunk
  });
});
