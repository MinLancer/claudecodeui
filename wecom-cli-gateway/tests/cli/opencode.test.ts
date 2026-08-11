import { describe, it, expect } from "vitest";
import { OpencodeAdapter } from "../../src/cli/opencode.js";
import type { SpawnedCli } from "../../src/cli/spawn-cli.js";

// 桩 spawnCli:模拟 opencode run --format json 的输出(每行一个 JSON)。
// 真实格式(参照 claudecodeui opencode-runtime.provider):
//   事件含 sessionID/sessionId 字段、content 等。具体 schema 官方文档未展开,基于源码推断。
function fakeSpawnCli(lines: string[]): (p: any) => SpawnedCli {
  return () => ({
    stdout: (async function* () { for (const l of lines) yield l; })(),
    kill() {},
    onExit: (cb) => { cb(0); return () => {}; },
  });
}

describe("OpencodeAdapter", () => {
  it("新建会话:捕获 sessionID,推送 final", async () => {
    const adapter = new OpencodeAdapter({
      spawnCli: fakeSpawnCli([
        JSON.stringify({ type: "session", sessionID: "oc-sid-1" }),
        JSON.stringify({ type: "message", content: "回复" }),
        JSON.stringify({ type: "finish" }),
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const finals: string[] = [];
    for await (const c of session.send("帮我")) {
      if (c.type === "final") finals.push(c.text);
    }
    expect(session.sessionId).toBe("oc-sid-1");
    expect(finals).toContain("回复");
  });

  it("resume:start 携带 sessionId 时 args 含 --session", async () => {
    let capturedArgs: string[] = [];
    const adapter = new OpencodeAdapter({
      spawnCli: (p) => { capturedArgs = p.args; return fakeSpawnCli([JSON.stringify({ type: "finish" })])(); },
    });
    const session = await adapter.start({ projectDir: "/tmp/proj", sessionId: "oc-old" });
    for await (const _ of session.send("继续")) { _; }
    expect(capturedArgs.join(" ")).toContain("--session oc-old");
  });

  it("args 含 run --format json --dir", async () => {
    let capturedArgs: string[] = [];
    let capturedCwd: string = "";
    const adapter = new OpencodeAdapter({
      spawnCli: (p) => { capturedArgs = p.args; capturedCwd = p.cwd; return fakeSpawnCli([JSON.stringify({ type: "finish" })])(); },
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    for await (const _ of session.send("你好")) { _; }
    expect(capturedArgs.join(" ")).toContain("run");
    expect(capturedArgs.join(" ")).toContain("--format json");
    expect(capturedArgs.join(" ")).toContain("--dir");
    expect(capturedCwd).toBe("/tmp/proj");
    // prompt 作参数
    expect(capturedArgs.some((a) => a.includes("你好"))).toBe(true);
  });

  it("reasoning/thinking 识别为 thinking chunk", async () => {
    const adapter = new OpencodeAdapter({
      spawnCli: fakeSpawnCli([
        JSON.stringify({ type: "reasoning", content: "考虑" }),
        JSON.stringify({ type: "message", content: "结论" }),
        JSON.stringify({ type: "finish" }),
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const thoughts: string[] = [];
    for await (const c of session.send("想想")) {
      if (c.type === "thinking") thoughts.push(c.text);
    }
    expect(thoughts).toEqual(["考虑"]);
  });

  it("tool 事件识别为 tool chunk", async () => {
    const adapter = new OpencodeAdapter({
      spawnCli: fakeSpawnCli([
        JSON.stringify({ type: "tool_call", name: "bash", content: "ls" }),
        JSON.stringify({ type: "message", content: "完成" }),
        JSON.stringify({ type: "finish" }),
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const tools: string[] = [];
    for await (const c of session.send("跑命令")) {
      if (c.type === "tool") tools.push(c.text);
    }
    expect(tools.length).toBe(1);
    expect(tools[0]).toContain("bash");
  });

  it("无 finish 时 fallback 用 message content(避免空回复)", async () => {
    const adapter = new OpencodeAdapter({
      spawnCli: fakeSpawnCli([
        JSON.stringify({ type: "session", sessionID: "s" }),
        JSON.stringify({ type: "message", content: "部分回复" }),
        // 无 finish(异常截断)
      ]),
    });
    const session = await adapter.start({ projectDir: "/tmp/proj" });
    const finals: string[] = [];
    for await (const c of session.send("帮我")) {
      if (c.type === "final") finals.push(c.text);
    }
    expect(finals).toContain("部分回复");
  });
});
