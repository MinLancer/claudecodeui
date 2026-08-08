import { describe, it, expect } from "vitest";
import { ClaudeAdapter } from "../../src/cli/claude.js";

// SDK query 注入桩:模拟 @anthropic-ai/claude-agent-sdk 的 query() 行为。
// 真实 SDK:query({prompt, options}) 返回 AsyncIterable<SDKMessage>,消息形态:
//   {type:"system", subtype:"init", session_id}
//   {type:"assistant", message:{content:[{type:"text"|"thinking"|"tool_use"|"tool_result", ...}]}}
//   {type:"result", subtype:"success", result, session_id}
function fakeQuery(messages: any[]) {
  return async function* (_params: { prompt: string; options?: any }) {
    for (const m of messages) yield m;
  };
}

describe("ClaudeAdapter", () => {
  it("新建会话:send 返回 final 文本,捕获 session_id", async () => {
    const adapter = new ClaudeAdapter({
      query: fakeQuery([
        { type: "system", subtype: "init", session_id: "sid-new" },
        { type: "assistant", message: { content: [{ type: "text", text: "好的" }] }, session_id: "sid-new" },
        { type: "result", subtype: "success", result: "好的,已完成", session_id: "sid-new" },
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const chunks: string[] = [];
    for await (const c of session.send("帮我")) {
      if (c.type === "final") chunks.push(c.text);
    }
    expect(chunks).toEqual(["好的,已完成"]); // 不重复
    expect(session.sessionId).toBe("sid-new");
  });

  it("resume 会话:start 携带 sessionId 时 query options 含 resume", async () => {
    let capturedOpts: any;
    const adapter = new ClaudeAdapter({
      query: async function* (params) {
        capturedOpts = params.options;
        yield { type: "result", subtype: "success", result: "续", session_id: "sid-old" };
      },
    });
    const session = await adapter.start({ projectDir: "/tmp/proj", sessionId: "sid-old" });
    for await (const _ of session.send("继续")) { _; }
    expect(capturedOpts.resume).toBe("sid-old");
    expect(capturedOpts.cwd).toBe("/tmp/proj");
  });

  it("final 不重复(assistant text 与 result.result 同文本)", async () => {
    const adapter = new ClaudeAdapter({
      query: fakeQuery([
        { type: "system", subtype: "init", session_id: "sid-real" },
        { type: "assistant", message: { content: [{ type: "thinking", thinking: "用户要求只回一个字" }] }, session_id: "sid-real" },
        { type: "assistant", message: { content: [{ type: "text", text: "好" }] }, session_id: "sid-real" },
        { type: "result", subtype: "success", result: "好", session_id: "sid-real" },
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const finals: string[] = [];
    for await (const c of session.send("只回一个字:好")) {
      if (c.type === "final") finals.push(c.text);
    }
    expect(finals).toEqual(["好"]);
    expect(session.sessionId).toBe("sid-real");
  });

  it("assistant content 中的 tool_use/tool_result 识别为 tool chunk", async () => {
    const adapter = new ClaudeAdapter({
      query: fakeQuery([
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
        { type: "assistant", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file.txt" }] } },
        { type: "result", subtype: "success", result: "列出完成" },
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const tools: string[] = [];
    for await (const c of session.send("列出文件")) {
      if (c.type === "tool") tools.push(c.text);
    }
    expect(tools.length).toBe(2);
    expect(tools[0]).toContain("Bash");
  });

  it("thinking 内容识别为 thinking chunk", async () => {
    const adapter = new ClaudeAdapter({
      query: fakeQuery([
        { type: "assistant", message: { content: [{ type: "thinking", thinking: "考虑一下" }] } },
        { type: "result", subtype: "success", result: "结论" },
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const thoughts: string[] = [];
    for await (const c of session.send("想想")) {
      if (c.type === "thinking") thoughts.push(c.text);
    }
    expect(thoughts).toEqual(["考虑一下"]);
  });

  it("无 result 时 fallback 用 assistant text(避免空回复)", async () => {
    const adapter = new ClaudeAdapter({
      query: fakeQuery([
        { type: "system", subtype: "init", session_id: "sid-x" },
        { type: "assistant", message: { content: [{ type: "text", text: "部分回复" }] }, session_id: "sid-x" },
        // 无 result 消息(异常截断)
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const finals: string[] = [];
    for await (const c of session.send("帮我")) {
      if (c.type === "final") finals.push(c.text);
    }
    expect(finals).toEqual(["部分回复"]);
    expect(session.sessionId).toBe("sid-x");
  });
});
