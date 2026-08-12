import { describe, it, expect } from "vitest";
import { parseSseEvents, extractText } from "../../src/cli/ccui-sse.js";

async function* fromBuffers(bufs: Buffer[]) {
  for (const b of bufs) yield b;
}

describe("parseSseEvents", () => {
  it("单 chunk 含完整事件", async () => {
    const input = Buffer.from(`data: ${JSON.stringify({ type: "status", message: "hi" })}\n\n`);
    const events = [];
    for await (const e of parseSseEvents(fromBuffers([input]))) events.push(e);
    expect(events).toEqual([{ type: "status", message: "hi" }]);
  });

  it("事件跨多个 chunk 边界", async () => {
    const json = JSON.stringify({ type: "done" });
    const part1 = Buffer.from(`data: ${json.slice(0, 5)}`);
    const part2 = Buffer.from(`${json.slice(5)}\n\n`);
    const events = [];
    for await (const e of parseSseEvents(fromBuffers([part1, part2]))) events.push(e);
    expect(events).toEqual([{ type: "done" }]);
  });

  it("多个事件在一个 chunk", async () => {
    const a = `data: ${JSON.stringify({ type: "session-id", sessionId: "s1" })}\n\n`;
    const b = `data: ${JSON.stringify({ type: "done" })}\n\n`;
    const events = [];
    for await (const e of parseSseEvents(fromBuffers([Buffer.from(a + b)]))) events.push(e);
    expect(events).toEqual([
      { type: "session-id", sessionId: "s1" },
      { type: "done" },
    ]);
  });

  it("非 JSON 的 data 行被跳过", async () => {
    const input = Buffer.from(`data: not-json\n\ndata: ${JSON.stringify({ type: "done" })}\n\n`);
    const events = [];
    for await (const e of parseSseEvents(fromBuffers([input]))) events.push(e);
    expect(events).toEqual([{ type: "done" }]);
  });

  it("无 type 字段的 JSON 被跳过", async () => {
    const input = Buffer.from(`data: ${JSON.stringify({ foo: "bar" })}\n\n`);
    const events = [];
    for await (const e of parseSseEvents(fromBuffers([input]))) events.push(e);
    expect(events).toEqual([]);
  });

  it("kind 字段事件也能解析(无 type,claude 消息格式)", async () => {
    const input = Buffer.from(`data: ${JSON.stringify({ kind: "text", role: "assistant", content: "你好" })}\n\n`);
    const events = [];
    for await (const e of parseSseEvents(fromBuffers([input]))) events.push(e);
    expect(events).toEqual([{ kind: "text", role: "assistant", content: "你好" }]);
  });
});

describe("extractText", () => {
  it("claude-response 含单个 text 块", () => {
    const ev = { type: "claude-response", data: { type: "assistant", message: { content: [{ type: "text", text: "你好" }] } } };
    expect(extractText(ev)).toBe("你好");
  });

  it("claude-response 含多个 text 块拼接", () => {
    const ev = { type: "claude-response", data: { type: "assistant", message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } } };
    expect(extractText(ev)).toBe("ab");
  });

  it("claude-response 仅含 thinking/tool_use(无 text)返回 null", () => {
    const ev = { type: "claude-response", data: { type: "assistant", message: { content: [{ type: "thinking", thinking: "..." }, { type: "tool_use", name: "Bash" }] } } };
    expect(extractText(ev)).toBeNull();
  });

  it("claude-response data 无 message 时降级取 data 本身", () => {
    const ev = { type: "claude-response", data: { content: [{ type: "text", text: "x" }] } };
    expect(extractText(ev)).toBe("x");
  });

  it("cursor-output 事件取 output", () => {
    const ev = { type: "cursor-output", output: "cursor 文本" };
    expect(extractText(ev)).toBe("cursor 文本");
  });

  it("text 事件取 text", () => {
    const ev = { type: "text", text: "纯文本" };
    expect(extractText(ev)).toBe("纯文本");
  });

  it("status/session-id/done/error 返回 null", () => {
    expect(extractText({ type: "status", message: "x" })).toBeNull();
    expect(extractText({ type: "session-id", sessionId: "s" })).toBeNull();
    expect(extractText({ type: "done" })).toBeNull();
    expect(extractText({ type: "error", error: "e" })).toBeNull();
  });

  it("claude 真实格式 kind:text role:assistant 取 content", () => {
    expect(extractText({ kind: "text", role: "assistant", content: "你的消息似乎出现了编码乱码" })).toBe("你的消息似乎出现了编码乱码");
  });

  it("kind:thinking 返回 null(非回复)", () => {
    expect(extractText({ kind: "thinking", content: "思考中" })).toBeNull();
  });

  it("kind:tool_use / tool_result 返回 null", () => {
    expect(extractText({ kind: "tool_use", toolName: "Bash", toolInput: {} })).toBeNull();
    expect(extractText({ kind: "tool_result", toolId: "t", content: "..." })).toBeNull();
  });

  it("kind:status token_budget 返回 null(有 text 字段但不提取)", () => {
    expect(extractText({ kind: "status", text: "token_budget", tokenBudget: {} })).toBeNull();
  });

  it("kind:complete / session_created 返回 null", () => {
    expect(extractText({ kind: "complete", exitCode: 0 })).toBeNull();
    expect(extractText({ kind: "session_created", newSessionId: "s" })).toBeNull();
  });
});
