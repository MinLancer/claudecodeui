import { describe, it, expect } from "vitest";
import { CursorAdapter } from "../../src/cli/cursor.js";
import type { SpawnedCli } from "../../src/cli/spawn-cli.js";

// 桩 spawnCli:模拟 cursor-agent 的 stream-json 输出(每行一个 JSON)。
// 真实格式(参照 claudecodeui cursor-runtime.provider):
//   {"type":"system","subtype":"init","session_id":"...","cwd":"..."}
//   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
//   {"type":"result","result":"..."}
function fakeSpawnCli(lines: string[]): (p: any) => SpawnedCli {
  return () => ({
    stdout: (async function* () { for (const l of lines) yield l; })(),
    kill() {},
    onExit: (cb) => { cb(0); return () => {}; },
  });
}

describe("CursorAdapter", () => {
  it("新建会话:捕获 session_id,推送 final", async () => {
    const adapter = new CursorAdapter({
      spawnCli: fakeSpawnCli([
        JSON.stringify({ type: "system", subtype: "init", session_id: "cur-sid-1", cwd: "/tmp/proj" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "回复" }] } }),
        JSON.stringify({ type: "result", result: "回复" }),
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const finals: string[] = [];
    for await (const c of session.send("帮我")) {
      if (c.type === "final") finals.push(c.text);
    }
    expect(session.sessionId).toBe("cur-sid-1");
    expect(finals).toContain("回复");
  });

  it("resume:start 携带 sessionId 时 args 含 --resume", async () => {
    let capturedArgs: string[] = [];
    const adapter = new CursorAdapter({
      spawnCli: (p) => { capturedArgs = p.args; return fakeSpawnCli([JSON.stringify({ type: "result", result: "续" })])(); },
    });
    const session = await adapter.start({ projectDir: "/tmp/proj", sessionId: "cur-old" });
    for await (const _ of session.send("继续")) { _; }
    expect(capturedArgs.join(" ")).toContain("--resume=cur-old");
  });

  it("args 含 -p --output-format stream-json", async () => {
    let capturedArgs: string[] = [];
    const adapter = new CursorAdapter({
      spawnCli: (p) => { capturedArgs = p.args; return fakeSpawnCli([JSON.stringify({ type: "result", result: "ok" })])(); },
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    for await (const _ of session.send("你好")) { _; }
    expect(capturedArgs.join(" ")).toContain("--output-format stream-json");
    expect(capturedArgs.join(" ")).toContain("-f"); // 跳过权限
    // prompt 作参数(去换行)
    expect(capturedArgs.some((a) => a.includes("你好"))).toBe(true);
  });

  it("thinking content 识别为 thinking chunk", async () => {
    const adapter = new CursorAdapter({
      spawnCli: fakeSpawnCli([
        JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "考虑" }] } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "结论" }] } }),
        JSON.stringify({ type: "result", result: "结论" }),
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const thoughts: string[] = [];
    for await (const c of session.send("想想")) {
      if (c.type === "thinking") thoughts.push(c.text);
    }
    expect(thoughts).toEqual(["考虑"]);
  });

  it("tool_use 识别为 tool chunk", async () => {
    const adapter = new CursorAdapter({
      spawnCli: fakeSpawnCli([
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { cmd: "ls" } }] } }),
        JSON.stringify({ type: "result", result: "完成" }),
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const tools: string[] = [];
    for await (const c of session.send("跑命令")) {
      if (c.type === "tool") tools.push(c.text);
    }
    expect(tools.length).toBe(1);
    expect(tools[0]).toContain("Bash");
  });

  it("final 不重复(assistant text 与 result.result 同文本)", async () => {
    const adapter = new CursorAdapter({
      spawnCli: fakeSpawnCli([
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "好" }] } }),
        JSON.stringify({ type: "result", result: "好" }),
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const finals: string[] = [];
    for await (const c of session.send("只回好")) {
      if (c.type === "final") finals.push(c.text);
    }
    // result.result 为唯一 final 来源,assistant text 暂存不重复 yield
    expect(finals).toEqual(["好"]);
  });
});
