import { describe, it, expect } from "vitest";
import { CodexAdapter } from "../../src/cli/codex.js";

// 桩 runCodex:模拟 @openai/codex-sdk 的事件流。
// 真实 SDK:runStreamed 返回 events async iterable,事件有 item.started/updated/completed、
// turn.completed/failed、thread.started 等,含 type/content/role 字段。
function fakeRunCodex(events: any[]) {
  return async function* (_params: { prompt: string; cwd: string; resume?: string; signal?: AbortSignal }) {
    for (const e of events) yield e;
  };
}

describe("CodexAdapter", () => {
  it("新建会话:捕获 session_id,推送 final", async () => {
    const adapter = new CodexAdapter({
      runCodex: fakeRunCodex([
        { type: "thread.started", sessionId: "codex-sid-1" },
        { type: "item.updated", itemType: "agent_message", content: "回复" },
        { type: "turn.completed" },
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const finals: string[] = [];
    for await (const c of session.send("帮我")) {
      if (c.type === "final") finals.push(c.text);
    }
    expect(session.sessionId).toBe("codex-sid-1");
    expect(finals).toContain("回复");
  });

  it("resume:start 携带 sessionId 时 runCodex 收到 resume", async () => {
    let capturedResume: string | undefined;
    const adapter = new CodexAdapter({
      runCodex: async function* (params) {
        capturedResume = params.resume;
        yield { type: "turn.completed" };
      },
    });
    const session = await adapter.start({ projectDir: "/tmp/proj", sessionId: "codex-old" });
    for await (const _ of session.send("继续")) { _; }
    expect(capturedResume).toBe("codex-old");
  });

  it("reasoning 项识别为 thinking chunk", async () => {
    const adapter = new CodexAdapter({
      runCodex: fakeRunCodex([
        { type: "item.updated", itemType: "reasoning", content: "考虑一下" },
        { type: "item.updated", itemType: "agent_message", content: "结论" },
        { type: "turn.completed" },
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const thoughts: string[] = [];
    for await (const c of session.send("想想")) {
      if (c.type === "thinking") thoughts.push(c.text);
    }
    expect(thoughts).toEqual(["考虑一下"]);
  });

  it("command_execution/mcp_tool_call 识别为 tool chunk", async () => {
    const adapter = new CodexAdapter({
      runCodex: fakeRunCodex([
        { type: "item.updated", itemType: "command_execution", content: "ls -la" },
        { type: "item.updated", itemType: "mcp_tool_call", content: "read_file" },
        { type: "item.updated", itemType: "agent_message", content: "完成" },
        { type: "turn.completed" },
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const tools: string[] = [];
    for await (const c of session.send("跑命令")) {
      if (c.type === "tool") tools.push(c.text);
    }
    expect(tools.length).toBe(2);
  });

  it("无 turn.completed 时 fallback 用 agent_message(避免空回复)", async () => {
    const adapter = new CodexAdapter({
      runCodex: fakeRunCodex([
        { type: "thread.started", sessionId: "s" },
        { type: "item.updated", itemType: "agent_message", content: "部分回复" },
        // 无 turn.completed(异常截断)
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const finals: string[] = [];
    for await (const c of session.send("帮我")) {
      if (c.type === "final") finals.push(c.text);
    }
    expect(finals).toContain("部分回复");
  });

  it("kill 调用 abort signal", async () => {
    let aborted = false;
    const adapter = new CodexAdapter({
      runCodex: async function* (params) {
        params.signal?.addEventListener("abort", () => { aborted = true; });
        yield { type: "item.updated", itemType: "agent_message", content: "x" };
        yield { type: "turn.completed" };
      },
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    // kill 在 send 迭代中调(此时 abortController 已创建)
    for await (const c of session.send("x")) {
      session.kill();
      void c;
    }
    expect(aborted).toBe(true);
  });
});
