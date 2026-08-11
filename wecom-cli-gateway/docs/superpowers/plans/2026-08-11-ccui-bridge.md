# 企微网关桥接 claudecodeui (ccui-bridge) 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 wecom-cli-gateway 的 CLI 适配器层通过 HTTP 调用 claudecodeui 的 `POST /api/agent` 外部 API 并订阅其 SSE 流,使企微消息能复用 claudecodeui 已有的 Web UI 后端能力(CLI/MCP/技能),无需在网关内独立实现 CLI 调用。

**Architecture:** 新增一个 `CcuiAdapter` 实现 `CliAdapter` 接口,通过 `fetch` POST `/api/agent`(携带 `x-api-key`),解析 SSE 事件流(`data: {JSON}\n\n`),从 `claude-response` 事件提取 assistant 文本,转为网关的 `StreamChunk`。provider(claude/codex/cursor/opencode)与 cliType 一一映射;`projectDir` 直接作为 `projectPath`。配置 `clis.ccui` 存在时,4 个 cliType 都走 `CcuiAdapter`;否则回退到现有 `ClaudeAdapter`/`CodexAdapter`/`CursorAdapter`/`OpencodeAdapter`(旧适配器保留备用)。

**Tech Stack:** TypeScript, Node 18+ 全局 `fetch`,`vitest` 测试,`zod` schema,fastify 网关,express(claudecodeui)。

## Global Constraints

- **认证模式**:自托管模式(`x-api-key` header),不使用 `IS_PLATFORM`。API key 由 claudecodeui Web UI 的 settings 页创建。
- **provider 映射**:`CliType`("claude"|"codex"|"cursor"|"opencode")直接作为 `/api/agent` body 的 `provider` 字段,无转换。
- **projectPath**:`CliStartOpts.projectDir` 原样作为 `/api/agent` body 的 `projectPath`。
- **旧适配器保留**:`config.clis.ccui` 缺失时,index.ts 回退到现有 4 个 adapter,不删除它们。
- **SSE 格式依据**:claudecodeui `server/modules/git/git.routes.ts:1050-1063` 的真实消费代码(生产中用于 AI 生成 commit message),以及 `server/modules/agent/agent.routes.ts:575` 的 `ResponseCollector.getAssistantMessages`。两处独立解析同一格式:`{type:"claude-response", data:{type:"assistant", message:{content:[{type:"text", text}]}}}`。
- **测试运行命令(Windows WSL 规避)**:`node ./node_modules/vitest/vitest.mjs run <测试文件> --pool=forks --poolOptions.forks.singleFork`。直接 `npx vitest` 在 Windows 会触发 `execvpe(/bin/bash) failed` 噪音。
- **tsc 检查命令**:`node ./node_modules/typescript/bin/tsc --noEmit`(在 `wecom-cli-gateway` 目录)。
- **所有命令在 `wecom-cli-gateway` 目录执行**(除非另注)。

## 文件结构

| 文件 | 职责 | 任务 |
|------|------|------|
| `src/cli/ccui-sse.ts` | 纯函数:`parseSseEvents`(解析 SSE 字节流为事件)、`extractText`(从事件提取文本) | Task 1, 2 |
| `src/cli/ccui.ts` | `FetchSseFn` 类型、`CcuiSession`(send/kill)、`CcuiAdapter`(isAvailable/start)、`defaultFetchSse`(真实 fetch 实现) | Task 3, 4 |
| `src/cli/registry.ts` | `buildCliAdapters(cfg, deps)` 纯函数:ccui 配置存在时返回 4 个 CcuiAdapter,否则回退旧 adapter | Task 6 |
| `src/config/schema.ts` | 新增 `CcuiConfigSchema` + `clis.ccui` 可选字段 | Task 5 |
| `src/index.ts` | 调用 `buildCliAdapters` 装配 `cliAdapters` | Task 6 |
| `tests/cli/ccui-sse.test.ts` | parseSseEvents / extractText 单测 | Task 1, 2 |
| `tests/cli/ccui.test.ts` | CcuiSession / CcuiAdapter 单测(注入 fakeFetchSse) | Task 3, 4 |
| `tests/cli/registry.test.ts` | buildCliAdapters 单测 | Task 6 |
| `tests/config/loader.test.ts` | 追加 ccui 配置解析 case | Task 5 |
| `docs/ccui-bridge-setup.md` | 联调步骤:启动 claudecodeui、创建 API key、配置网关、验证 | Task 7 |

---

## Task 1: SSE 事件解析器 `parseSseEvents`

**Files:**
- Create: `src/cli/ccui-sse.ts`
- Test: `tests/cli/ccui-sse.test.ts`

**Interfaces:**
- Produces:
  - `export type SseEvent = { type: string; data?: unknown }`
  - `export async function* parseSseEvents(chunks: AsyncIterable<Buffer>): AsyncIterable<SseEvent>`

**依据**:claudecodeui `agent.routes.ts` 的 `SSEStreamWriter.send` 输出格式为 `data: ${JSON.stringify(obj)}\n\n`。一个事件块 = 以 `\n\n` 分隔的文本段,内含一行或多行 `data: <json>`(多行时按 SSE 规范用 `\n` 拼接后 JSON.parse)。

- [ ] **Step 1: 写失败测试**

创建 `tests/cli/ccui-sse.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseSseEvents } from "../../src/cli/ccui-sse.js";

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
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/cli/ccui-sse.test.ts --pool=forks --poolOptions.forks.singleFork`
Expected: FAIL,`parseSseEvents` 未导出/模块找不到。

- [ ] **Step 3: 实现 `parseSseEvents`**

创建 `src/cli/ccui-sse.ts`:

```typescript
// claudecodeui /api/agent 的 SSE 流解析。
// 事件格式(SSEStreamWriter.send):`data: ${JSON}\n\n`,多行 data 按 SSE 规范以 \n 拼接。

export type SseEvent = { type: string; data?: unknown };

export async function* parseSseEvents(chunks: AsyncIterable<Buffer>): AsyncIterable<SseEvent> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (dataLines.length === 0) continue;
      try {
        const parsed = JSON.parse(dataLines.join("\n"));
        if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
          yield parsed as SseEvent;
        }
      } catch {
        // 非 JSON data,跳过
      }
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/cli/ccui-sse.test.ts --pool=forks --poolOptions.forks.singleFork`
Expected: PASS(5 个用例)。

- [ ] **Step 5: tsc 检查**

Run: `node ./node_modules/typescript/bin/tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/cli/ccui-sse.ts tests/cli/ccui-sse.test.ts
git commit -m "feat(ccui): 添加 SSE 事件解析器 parseSseEvents"
```

---

## Task 2: claude-response 文本提取 `extractText`

**Files:**
- Modify: `src/cli/ccui-sse.ts`(追加函数)
- Test: `tests/cli/ccui-sse.test.ts`(追加用例)

**Interfaces:**
- Consumes:`SseEvent`(Task 1 产出)
- Produces:`export function extractText(event: SseEvent): string | null`

**依据**:`git.routes.ts:1051-1063` 实证逻辑——`claude-response` 事件的 `data.message.content` 数组中,取每个 `type==="text"` 元素的 `text` 拼接;`cursor-output` 事件取 `output`;`text` 事件取 `text`。其他 type 返回 null。

- [ ] **Step 1: 写失败测试**

在 `tests/cli/ccui-sse.test.ts` 末尾追加:

```typescript
import { extractText } from "../../src/cli/ccui-sse.js";

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
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/cli/ccui-sse.test.ts --pool=forks --poolOptions.forks.singleFork`
Expected: FAIL,`extractText` 未导出。

- [ ] **Step 3: 实现 `extractText`**

在 `src/cli/ccui-sse.ts` 追加:

```typescript
// 从 SSE 事件提取面向用户的文本。
// 依据:claudecodeui server/modules/git/git.routes.ts:1051-1063 的真实消费逻辑。
export function extractText(event: SseEvent): string | null {
  const e = event as Record<string, unknown>;
  if (e.type === "claude-response" && e.data) {
    const data = e.data as Record<string, unknown>;
    const message = (data.message as Record<string, unknown>) || data;
    const content = message && (message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      let text = "";
      for (const item of content) {
        if (item && typeof item === "object"
          && (item as Record<string, unknown>).type === "text"
          && typeof (item as Record<string, unknown>).text === "string") {
          text += (item as Record<string, unknown>).text as string;
        }
      }
      return text || null;
    }
    return null;
  }
  if (e.type === "cursor-output" && typeof e.output === "string") {
    return e.output;
  }
  if (e.type === "text" && typeof e.text === "string") {
    return e.text;
  }
  return null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/cli/ccui-sse.test.ts --pool=forks --poolOptions.forks.singleFork`
Expected: PASS(全部用例)。

- [ ] **Step 5: tsc 检查**

Run: `node ./node_modules/typescript/bin/tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/cli/ccui-sse.ts tests/cli/ccui-sse.test.ts
git commit -m "feat(ccui): 添加 claude-response 文本提取 extractText"
```

---

## Task 3: CcuiSession(send + kill)

**Files:**
- Create: `src/cli/ccui.ts`
- Test: `tests/cli/ccui.test.ts`

**Interfaces:**
- Consumes:
  - `CliSession`、`StreamChunk`、`CliType` from `./types.js`(已存在)
  - `parseSseEvents`、`extractText`、`SseEvent` from `./ccui-sse.js`(Task 1, 2 产出)
- Produces:
  - `export type FetchSseFn = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => AsyncIterable<Buffer>`
  - `export class CcuiSession implements CliSession`(send/kill/sessionId)

**契约**:send 发 POST `/api/agent`,body `{projectPath: projectDir, message: text, provider, stream: true, sessionId?}`;消费 SSE:`session-id` 事件捕获 `this.sessionId`;`error` 事件 yield `{type:"error", text}`;`done` 事件结束;其他事件经 `extractText` 提取,非空 yield `{type:"final", text}`。kill 通过 AbortController 中断。

- [ ] **Step 1: 写失败测试**

创建 `tests/cli/ccui.test.ts`:

```typescript
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/cli/ccui.test.ts --pool=forks --poolOptions.forks.singleFork`
Expected: FAIL,`CcuiSession`/`FetchSseFn` 未导出。

- [ ] **Step 3: 实现 `CcuiSession`**

创建 `src/cli/ccui.ts`:

```typescript
import type { CliSession, StreamChunk, CliType } from "./types.js";
import { parseSseEvents, extractText } from "./ccui-sse.js";

// 注入式 SSE fetch:返回原始字节流,便于测试。
export type FetchSseFn = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }
) => AsyncIterable<Buffer>;

export interface CcuiSessionOpts {
  baseUrl: string;
  apiKey: string;
  provider: CliType;
  projectDir: string;
  sessionId?: string;
  fetchSse: FetchSseFn;
  timeoutMs: number;
}

export class CcuiSession implements CliSession {
  sessionId?: string;
  private aborted = false;
  private controller?: AbortController;

  constructor(private opts: CcuiSessionOpts) {}

  async *send(text: string): AsyncIterable<StreamChunk> {
    this.controller = new AbortController();
    const timer = setTimeout(() => this.controller!.abort(), this.opts.timeoutMs);
    try {
      const body = JSON.stringify({
        projectPath: this.opts.projectDir,
        message: text,
        provider: this.opts.provider,
        stream: true,
        sessionId: this.opts.sessionId || undefined,
      });
      const chunks = this.opts.fetchSse(`${this.opts.baseUrl}/api/agent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.opts.apiKey },
        body,
        signal: this.controller.signal,
      });
      for await (const event of parseSseEvents(chunks)) {
        if (this.aborted) break;
        const ev = event as Record<string, unknown>;
        if (ev.type === "session-id" && typeof ev.sessionId === "string") {
          this.sessionId = ev.sessionId as string;
          continue;
        }
        if (ev.type === "error") {
          yield { type: "error", text: String(ev.error ?? "上游错误") };
          continue;
        }
        if (ev.type === "done") break;
        const t = extractText(event);
        if (t) yield { type: "final", text: t };
      }
    } catch (e) {
      yield { type: "error", text: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  kill(): void {
    this.aborted = true;
    this.controller?.abort();
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/cli/ccui.test.ts --pool=forks --poolOptions.forks.singleFork`
Expected: PASS(6 个用例)。

- [ ] **Step 5: tsc 检查**

Run: `node ./node_modules/typescript/bin/tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/cli/ccui.ts tests/cli/ccui.test.ts
git commit -m "feat(ccui): 实现 CcuiSession 消费 /api/agent SSE 流"
```

---

## Task 4: CcuiAdapter + defaultFetchSse

**Files:**
- Modify: `src/cli/ccui.ts`(追加)
- Test: `tests/cli/ccui.test.ts`(追加用例)

**Interfaces:**
- Consumes:`CliAdapter`、`CliStartOpts` from `./types.js`;`CcuiSession`、`FetchSseFn`(Task 3 产出)
- Produces:
  - `export interface CcuiAdapterOpts { baseUrl: string; apiKey: string; provider: CliType; fetchSse: FetchSseFn; timeoutMs?: number }`
  - `export class CcuiAdapter implements CliAdapter`
  - `export const defaultFetchSse: FetchSseFn`(用全局 `fetch` + `ReadableStream` 产出 Buffer 流)

- [ ] **Step 1: 写失败测试**

在 `tests/cli/ccui.test.ts` 追加:

```typescript
import { CcuiAdapter, defaultFetchSse } from "../../src/cli/ccui.js";

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
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/cli/ccui.test.ts --pool=forks --poolOptions.forks.singleFork`
Expected: FAIL,`CcuiAdapter`/`defaultFetchSse` 未导出。

- [ ] **Step 3: 实现 `CcuiAdapter` 与 `defaultFetchSse`**

在 `src/cli/ccui.ts` 追加:

```typescript
import type { CliAdapter, CliStartOpts } from "./types.js";

export interface CcuiAdapterOpts {
  baseUrl: string;
  apiKey: string;
  provider: CliType;
  fetchSse: FetchSseFn;
  timeoutMs?: number;
}

export class CcuiAdapter implements CliAdapter {
  readonly type: CliType;
  constructor(private opts: CcuiAdapterOpts) {
    this.type = opts.provider;
  }

  // 与其他 adapter 一致:简化为 true。桥接模式下 /api/agent 可达性在首次 send 时验证。
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async start(opts: CliStartOpts): Promise<CliSession> {
    return new CcuiSession({
      baseUrl: this.opts.baseUrl,
      apiKey: this.opts.apiKey,
      provider: this.opts.provider,
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      fetchSse: this.opts.fetchSse,
      timeoutMs: this.opts.timeoutMs ?? 600000,
    });
  }
}

// 默认 SSE fetch 实现:用 Node 18+ 全局 fetch,把 ReadableStream 转成 Buffer 流。
export const defaultFetchSse: FetchSseFn = async function* (url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`/api/agent 返回 HTTP ${res.status}: ${detail}`);
  }
  if (!res.body) throw new Error("/api/agent 无响应体");
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield Buffer.from(value);
    }
  } finally {
    reader.releaseLock();
  }
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/cli/ccui.test.ts --pool=forks --poolOptions.forks.singleFork`
Expected: PASS(全部用例,含 Task 3 的 6 个 + 本任务 5 个)。

- [ ] **Step 5: tsc 检查**

Run: `node ./node_modules/typescript/bin/tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/cli/ccui.ts tests/cli/ccui.test.ts
git commit -m "feat(ccui): 实现 CcuiAdapter 与 defaultFetchSse"
```

---

## Task 5: Config schema 扩展(ccui)

**Files:**
- Modify: `src/config/schema.ts`
- Test: `tests/config/loader.test.ts`

**Interfaces:**
- Consumes:`AppConfigSchema`(已存在)
- Produces:
  - `export const CcuiConfigSchema`(z.object `{baseUrl: url, apiKey: non-empty, timeoutMs: positive int default 600000}`)
  - `AppConfigSchema.clis.ccui` 可选字段

- [ ] **Step 1: 写失败测试**

先读现有 `tests/config/loader.test.ts` 确认风格,然后追加:

```typescript
import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/loader.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("loadConfig ccui", () => {
  it("解析 clis.ccui 配置", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const file = join(dir, "config.yaml");
    writeFileSync(file, `
server:
  port: 3002
redis:
  url: redis://localhost:6379
bots:
  - id: wecom_1
    platform: wecom
    defaultCli: claude
    projectDir: /tmp/proj
    credentials:
      token: t
      aesKey: k
clis:
  claude:
    path: claude
  ccui:
    baseUrl: http://localhost:3001
    apiKey: key-abc
`);
    const cfg = loadConfig(file);
    expect(cfg.clis.ccui?.baseUrl).toBe("http://localhost:3001");
    expect(cfg.clis.ccui?.apiKey).toBe("key-abc");
    expect(cfg.clis.ccui?.timeoutMs).toBe(600000);
  });

  it("ccui 缺失时 cfg.clis.ccui 为 undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const file = join(dir, "config.yaml");
    writeFileSync(file, `
server: { port: 3002 }
redis: { url: redis://localhost:6379 }
bots:
  - id: wecom_1
    platform: wecom
    defaultCli: claude
    projectDir: /tmp/proj
    credentials: { token: t, aesKey: k }
clis:
  claude: { path: claude }
`);
    const cfg = loadConfig(file);
    expect(cfg.clis.ccui).toBeUndefined();
  });

  it("ccui.baseUrl 非法 URL 时 schema 报错", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const file = join(dir, "config.yaml");
    writeFileSync(file, `
server: { port: 3002 }
redis: { url: redis://localhost:6379 }
bots:
  - id: wecom_1
    platform: wecom
    defaultCli: claude
    projectDir: /tmp/proj
    credentials: { token: t, aesKey: k }
clis:
  claude: { path: claude }
  ccui:
    baseUrl: not-a-url
    apiKey: k
`);
    expect(() => loadConfig(file)).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/config/loader.test.ts --pool=forks --poolOptions.forks.singleFork`
Expected: FAIL,`cfg.clis.ccui` 不存在(schema 未定义)。

- [ ] **Step 3: 扩展 schema**

编辑 `src/config/schema.ts`,在 `CliConfigSchema` 之后、`BotConfigSchema` 之前新增 `CcuiConfigSchema`,并在 `AppConfigSchema.clis` 中加入 `ccui` 可选字段:

```typescript
// 在 CliConfigSchema 定义之后新增:
export const CcuiConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  timeoutMs: z.number().int().positive().default(600000),
});
```

将 `AppConfigSchema` 中的 `clis` 改为:

```typescript
  clis: z.object({
    claude: CliConfigSchema.default({ path: "claude" }),
    codex: CliConfigSchema.optional(),
    cursor: CliConfigSchema.optional(),
    opencode: CliConfigSchema.optional(),
    ccui: CcuiConfigSchema.optional(),
  }),
```

并导出类型(在文件末尾已有的 `export type` 区追加):

```typescript
export type CcuiConfig = z.infer<typeof CcuiConfigSchema>;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/config/loader.test.ts --pool=forks --poolOptions.forks.singleFork`
Expected: PASS(含新增 3 个 + 原有用例)。

- [ ] **Step 5: tsc 检查**

Run: `node ./node_modules/typescript/bin/tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/config/schema.ts tests/config/loader.test.ts
git commit -m "feat(config): 新增 clis.ccui 可选配置(桥接 claudecodeui)"
```

---

## Task 6: 装配 `buildCliAdapters` + index.ts 接入

**Files:**
- Create: `src/cli/registry.ts`
- Modify: `src/index.ts`
- Test: `tests/cli/registry.test.ts`

**Interfaces:**
- Consumes:
  - `AppConfig` from `../config/schema.js`(Task 5 产出,含 `clis.ccui`)
  - `CcuiAdapter`、`defaultFetchSse`、`FetchSseFn` from `./ccui.js`(Task 4 产出)
  - `ClaudeAdapter` from `./claude.js`、`CodexAdapter` from `./codex.js`、`CursorAdapter`/`OpencodeAdapter`(已存在)
  - `QueryFn` from `./claude.js`(已存在)
  - `realSpawnCli` from `./spawn-cli.js`(已存在)
- Produces:
  - `export interface BuildAdaptersDeps { claudeQuery: QueryFn; codexRun?: any; spawnCli: typeof realSpawnCli; fetchSse?: FetchSseFn }`
  - `export function buildCliAdapters(cfg: AppConfig, deps: BuildAdaptersDeps): Record<CliType, CliAdapter>`

**契约**:cfg.clis.ccui 存在时,4 个 cliType 各返回一个 `CcuiAdapter`(`provider` = cliType,`fetchSse` 默认 `defaultFetchSse`);否则回退到旧 adapter。

- [ ] **Step 1: 写失败测试**

创建 `tests/cli/registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildCliAdapters } from "../../src/cli/registry.js";
import { CcuiAdapter } from "../../src/cli/ccui.js";
import { ClaudeAdapter } from "../../src/cli/claude.js";
import type { AppConfig } from "../../src/config/schema.js";
import type { FetchSseFn } from "../../src/cli/ccui.js";

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
    // 仅验证不抛错(默认 fetchSse 在 start 前不会触发)
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
    // send 时 fakeFetchSse 返回空流(无事件),应正常结束无 chunk
    const chunks = [];
    for await (const c of session.send("hi")) chunks.push(c);
    expect(chunks).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/cli/registry.test.ts --pool=forks --poolOptions.forks.singleFork`
Expected: FAIL,`buildCliAdapters` 未导出。

- [ ] **Step 3: 实现 `buildCliAdapters`**

创建 `src/cli/registry.ts`:

```typescript
import type { CliAdapter, CliType } from "./types.js";
import type { AppConfig } from "../config/schema.js";
import type { QueryFn } from "./claude.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CursorAdapter } from "./cursor.js";
import { OpencodeAdapter } from "./opencode.js";
import { realSpawnCli } from "./spawn-cli.js";
import { CcuiAdapter, defaultFetchSse, type FetchSseFn } from "./ccui.js";

export interface BuildAdaptersDeps {
  claudeQuery: QueryFn;
  codexRun?: any;
  spawnCli: typeof realSpawnCli;
  fetchSse?: FetchSseFn;
}

export function buildCliAdapters(cfg: AppConfig, deps: BuildAdaptersDeps): Record<CliType, CliAdapter> {
  const ccui = cfg.clis.ccui;
  if (ccui) {
    const fetchSse = deps.fetchSse ?? defaultFetchSse;
    const make = (provider: CliType): CcuiAdapter =>
      new CcuiAdapter({
        baseUrl: ccui.baseUrl,
        apiKey: ccui.apiKey,
        provider,
        fetchSse,
        timeoutMs: ccui.timeoutMs,
      });
    return {
      claude: make("claude"),
      codex: make("codex"),
      cursor: make("cursor"),
      opencode: make("opencode"),
    };
  }
  // 旧适配器回退(保留备用)
  return {
    claude: new ClaudeAdapter({ query: deps.claudeQuery }),
    codex: new CodexAdapter({ runCodex: deps.codexRun }),
    cursor: new CursorAdapter({ spawnCli: deps.spawnCli }),
    opencode: new OpencodeAdapter({ spawnCli: deps.spawnCli }),
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/cli/registry.test.ts --pool=forks --poolOptions.forks.singleFork`
Expected: PASS(4 个用例)。

- [ ] **Step 5: index.ts 接入**

编辑 `src/index.ts`,用 `buildCliAdapters` 替换手写的 `cliAdapters` map。

在 import 区(`import { OpencodeAdapter } from "./cli/opencode.js";` 之后)新增:

```typescript
import { buildCliAdapters } from "./cli/registry.js";
```

将 index.ts 中原 `cliAdapters` 的构造块(约 66-72 行,`const cliAdapters: Record<CliType, CliAdapter> = { claude: new ClaudeAdapter(...), ... };`)替换为:

```typescript
  const cliAdapters: Record<CliType, CliAdapter> = buildCliAdapters(cfg, {
    claudeQuery,
    codexRun: await loadCodexRun(),
    spawnCli: realSpawnCli,
  });
```

注意:`ClaudeAdapter`/`CodexAdapter`/`CursorAdapter`/`OpencodeAdapter` 的 import 保留(旧适配器在 registry.ts 内仍使用);`CliAdapter`/`CliType` 类型 import 保留。

- [ ] **Step 6: 运行全量测试确认通过**

Run: `node ./node_modules/vitest/vitest.mjs run --pool=forks --poolOptions.forks.singleFork`
Expected: PASS(全部测试,含新增 ccui 相关 + 原有 66 个)。

- [ ] **Step 7: tsc 检查**

Run: `node ./node_modules/typescript/bin/tsc --noEmit`
Expected: 无错误。

- [ ] **Step 8: 提交**

```bash
git add src/cli/registry.ts src/index.ts tests/cli/registry.test.ts
git commit -m "feat(ccui): 装配 buildCliAdapters,ccui 配置存在时桥接 claudecodeui"
```

---

## Task 7: 联调文档

**Files:**
- Create: `docs/ccui-bridge-setup.md`

**说明**:本任务无单元测试,产出运维联调步骤文档。执行者在真实环境按步骤验证端到端链路。

- [ ] **Step 1: 创建联调文档**

创建 `docs/ccui-bridge-setup.md`:

```markdown
# 企微网关桥接 claudecodeui 联调指南

本指南将 wecom-cli-gateway 接入 claudecodeui 的 `POST /api/agent` 外部 API,使企微消息复用 claudecodeui 的 CLI 能力。

## 前置条件

- claudecodeui 源码位于 `F:\lancer_work\private\code\claudecodeui`(server 端口 3001)
- wecom-cli-gateway 位于其下 `wecom-cli-gateway/`(server 端口 3002)
- Node 18+(网关 `defaultFetchSse` 使用全局 `fetch`)
- Redis(wecom-redis 容器,默认 `redis://localhost:6379`)

## 1. 启动 claudecodeui

在 `claudecodeui` 目录(注意:不是 wecom-cli-gateway 子目录):

```bash
# .env 已存在:SERVER_PORT=3001 / HOST=0.0.0.0
npx tsx --tsconfig server/tsconfig.json server/index.ts
```

确认日志出现监听 3001。

## 2. 自托管模式:注册账号并创建 API key

claudecodeui Web UI 默认在 3001 端口提供前端页面。

1. 浏览器打开 `http://localhost:3001`
2. 注册一个账号(用户名 + 密码)
3. 登录后进入 Settings 页,创建一个 API key(命名为如 `wecom-gateway`)
4. 复制生成的 API key(形如 `ccui-...`,只显示一次)

> 注:claudecodeui 自托管模式下 `/api/agent` 通过 `x-api-key` 认证(见 `server/modules/agent/agent.routes.ts` 的 `validateExternalApiKey`)。`IS_PLATFORM` 环境变量不设置(保持自托管)。

## 3. 配置 wecom-cli-gateway

编辑 `wecom-cli-gateway/config.yaml`,在 `clis` 下新增 `ccui`:

```yaml
clis:
  claude:
    path: claude
  ccui:
    baseUrl: http://localhost:3001
    apiKey: <上一步复制的 API key>
    # timeoutMs: 600000   # 可选,默认 10 分钟
```

`bots` 配置不变(已有 wecom_1 bot,defaultCli=claude,projectDir 指向工作目录)。

## 4. 启动网关

在 `wecom-cli-gateway` 目录:

```bash
npm run dev
```

确认日志显示 `ccui` 桥接已启用(无 "旧适配器" 回退提示)。

## 5. 端到端验证

1. 确认 claudecodeui(3001)与网关(3002)都在运行
2. 在企微向机器人发送 `你好`
3. 检查网关日志:应出现 `[router] push stream=... finish=false`(流式推送)然后 `finish=true`
4. claudecodeui 日志应出现 `🤖 Starting Claude SDK session`
5. 企微端收到 claude 的回复

## 6. 故障排查

| 现象 | 排查 |
|------|------|
| 网关日志 `⚠️ claude 启动失败` | 检查 3001 是否监听;API key 是否正确 |
| 企微无回复,网关无 push 日志 | Redis 连接;加解密;参考已有排查记录 |
| claudecodeui 401 | API key 失效,重新生成 |
| claudecodeui 400 `Either githubUrl or projectPath` | bot.projectDir 路径不存在,确保目录已创建 |
| 超时 | 增大 bot.timeout 或 ccui.timeoutMs |

## 7. 回退到旧适配器

如需回退(不桥接 claudecodeui,直接用 claude-agent-sdk),删除 config.yaml 中 `clis.ccui` 段并重启网关,`buildCliAdapters` 自动回退到 `ClaudeAdapter`(旧适配器保留备用)。
```

- [ ] **Step 2: 提交**

```bash
git add docs/ccui-bridge-setup.md
git commit -m "docs(ccui): 桥接 claudecodeui 联调指南"
```

---

## Self-Review

**1. Spec coverage(对照 4 个用户决策点 + 整体目标):**

- 自托管模式认证:Task 3 的 send 设置 `x-api-key` header;Task 7 文档步骤 2 自托管创建 API key。✓
- provider 直接映射:Task 6 `buildCliAdapters` 中 `make(provider)` 把 cliType 原样作为 provider。✓
- projectDir 作 projectPath:Task 3 `CcuiSession.send` body `projectPath: this.opts.projectDir`,opts.projectDir 来自 `CliStartOpts.projectDir`(router 传入的 `this.deps.projectDir`)。✓
- 旧适配器保留备用:Task 6 `buildCliAdapters` 在 ccui 缺失时回退 `ClaudeAdapter` 等,旧文件不删除;Task 7 文档步骤 7 说明回退。✓
- 整体目标(桥接 /api/agent + SSE):Task 1-4 完整覆盖 SSE 解析与 HTTP 调用。✓

**2. Placeholder scan:**

- 无 "TBD"/"TODO"/"implement later"。
- 每个 code step 都有完整代码块。
- 测试用例都含具体断言。
- Task 7 是文档任务,无代码 placeholder,步骤具体到命令与配置。

**3. Type consistency:**

- `SseEvent`:Task 1 定义 `{type:string, data?:unknown}`,Task 2 `extractText(event: SseEvent)` 消费,Task 3 `parseSseEvents` 返回 `AsyncIterable<SseEvent>`。一致。✓
- `FetchSseFn`:Task 3 定义,Task 4 `CcuiAdapterOpts.fetchSse`、`defaultFetchSse: FetchSseFn` 消费,Task 6 `BuildAdaptersDeps.fetchSse?: FetchSseFn` 消费。一致。✓
- `CcuiSession`/`CcuiAdapter`:Task 3 定义 `CcuiSession`,Task 4 定义 `CcuiAdapter`(start 返回 `CliSession`,实际是 `CcuiSession`),Task 6 `make()` 返回 `CcuiAdapter`。一致。✓
- `CcuiConfigSchema`/`CcuiConfig`:Task 5 定义,Task 6 `cfg.clis.ccui`(类型来自 `AppConfig`)消费。一致。✓
- `buildCliAdapters` 签名:Task 6 定义 `(cfg, deps) => Record<CliType, CliAdapter>`,index.ts(Task 6 Step 5)调用方式匹配。✓

**4. 任务边界合理性:**

每个 Task 结束有独立可测试交付物(parseSseEvents、extractText、CcuiSession、CcuiAdapter、schema、buildCliAdapters、文档),符合"reviewer 可独立批准某任务而拒绝相邻任务"标准。

无遗漏。计划完整。

---

## Execution Handoff

计划已保存至 `wecom-cli-gateway/docs/superpowers/plans/2026-08-11-ccui-bridge.md`。两种执行方式:

**1. Subagent-Driven(推荐)** — 每个 Task 派发独立子代理,任务间 review,快速迭代。

**2. Inline Execution** — 在当前会话按 Task 顺序执行,带 checkpoint review。

请选择执行方式。
