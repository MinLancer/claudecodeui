import { describe, it, expect } from "vitest";
import { ClaudeAdapter } from "../../src/cli/claude.js";

// 桩 PTY:模拟 claude 的 stream-json 输出
// 真实输出:每行一个 JSON,含 type 字段(user/assistant/tool_use/tool_result 等)
function fakePty(lines: string[]) {
  let onLine: (line: string) => void = () => {};
  return {
    write: (_data: string) => {},
    kill: () => {},
    onData: (cb: (line: string) => void) => { onLine = cb; },
    emit: () => lines.forEach((l) => onLine(l + "\n")),
  };
}

describe("ClaudeAdapter", () => {
  it("新建会话:send 返回 final 文本,捕获 session_id", async () => {
    const adapter = new ClaudeAdapter({ path: "claude" }, {
      spawn: () => {
        const pty = fakePty([
          JSON.stringify({ type: "system", session_id: "sid-new" }),
          JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "好的" }] } }),
          JSON.stringify({ type: "result", result: "好的,已完成" }),
        ]);
        // spawn 后立即 emit(模拟 claude 已有输出)
        setTimeout(() => pty.emit(), 0);
        return pty as any;
      },
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const chunks: string[] = [];
    for await (const c of session.send("帮我")) {
      if (c.type === "final") chunks.push(c.text);
    }
    expect(chunks.join("")).toContain("好的,已完成");
    expect(session.sessionId).toBe("sid-new");
  });

  it("resume 会话:start 携带 sessionId 时命令含 --resume", async () => {
    let capturedCmd: string[] = [];
    const adapter = new ClaudeAdapter({ path: "claude" }, {
      spawn: (cmd: string, args: string[]) => {
        capturedCmd = [cmd, ...args];
        const pty = fakePty([JSON.stringify({ type: "result", result: "续" })]);
        setTimeout(() => pty.emit(), 0);
        return pty as any;
      },
    });
    const session = await adapter.start({ projectDir: "/tmp/proj", sessionId: "sid-old" });
    for await (const _ of session.send("继续")) { _; }
    expect(capturedCmd.join(" ")).toContain("--resume");
    expect(capturedCmd.join(" ")).toContain("sid-old");
  });
});
