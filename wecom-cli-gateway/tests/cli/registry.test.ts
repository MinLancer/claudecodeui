import { describe, it, expect } from "vitest";
import { buildCliAdapters } from "../../src/cli/registry.js";
import { CcuiAdapter, type FetchSseFn } from "../../src/cli/ccui.js";
import { ClaudeAdapter } from "../../src/cli/claude.js";
import type { AppConfig } from "../../src/config/schema.js";

const fakeQuery = async function* () { yield { type: "result", result: "x" }; } as any;
const fakeSpawn = (() => {}) as any;
const fakeFetchSse: FetchSseFn = async function* () { yield Buffer.from(""); };

function cfgWith(ccui?: { baseUrl: string; apiKey: string; timeoutMs?: number }): AppConfig {
  return {
    server: { port: 3002, logLevel: "info" },
    redis: { url: "redis://x" },
    bots: [{ id: "b1", platform: "wecom", defaultCli: "claude", projectDir: "/tmp", timeout: 180, allowedUsers: [], credentials: {} }],
    clis: {
      claude: { path: "claude" },
      ...(ccui ? { ccui } : {}),
    },
  } as any;
}

describe("buildCliAdapters", () => {
  it("ccui 配置存在:4 个 cliType 均为 CcuiAdapter,provider 正确", () => {
    const adapters = buildCliAdapters(cfgWith({ baseUrl: "http://x", apiKey: "k" }), {
      claudeQuery: fakeQuery, spawnCli: fakeSpawn,
    });
    expect(adapters.claude).toBeInstanceOf(CcuiAdapter);
    expect(adapters.codex).toBeInstanceOf(CcuiAdapter);
    expect(adapters.cursor).toBeInstanceOf(CcuiAdapter);
    expect(adapters.opencode).toBeInstanceOf(CcuiAdapter);
    expect((adapters.claude as CcuiAdapter).type).toBe("claude");
    expect((adapters.codex as CcuiAdapter).type).toBe("codex");
  });

  it("ccui 配置存在时使用默认 defaultFetchSse(未注入 fetchSse)", () => {
    const adapters = buildCliAdapters(cfgWith({ baseUrl: "http://x", apiKey: "k" }), {
      claudeQuery: fakeQuery, spawnCli: fakeSpawn,
    });
    expect(adapters.claude).toBeInstanceOf(CcuiAdapter);
  });

  it("ccui 缺失:回退到旧 ClaudeAdapter", () => {
    const adapters = buildCliAdapters(cfgWith(undefined), {
      claudeQuery: fakeQuery, spawnCli: fakeSpawn,
    });
    expect(adapters.claude).toBeInstanceOf(ClaudeAdapter);
  });

  it("注入 fetchSse 时 CcuiAdapter 使用它", async () => {
    const adapters = buildCliAdapters(cfgWith({ baseUrl: "http://x", apiKey: "k" }), {
      claudeQuery: fakeQuery, spawnCli: fakeSpawn, fetchSse: fakeFetchSse,
    });
    const session = await adapters.claude.start({ projectDir: "/tmp/p" });
    const chunks = [];
    for await (const c of session.send("hi")) chunks.push(c);
    expect(chunks).toEqual([]);
  });
});
