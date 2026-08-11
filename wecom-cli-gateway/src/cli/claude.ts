import type { CliAdapter, CliSession, CliStartOpts, StreamChunk } from "./types.js";

/**
 * ClaudeAdapter 基于 Anthropic 官方 @anthropic-ai/claude-agent-sdk 的 query()。
 *
 * 为什么用 SDK 而非 node-pty:claude -p 模式读 stdin 需 EOF,node-pty 的 PTY 给不了 EOF
 * (PTY stdin 永远"开着"),导致 claude 一直等不到输入完成。SDK 内部用 child_process.spawn
 * 真实 pipe + stdin.end(),天然能 EOF;且已解析 stream-json 为消息对象,无需手动行缓冲/JSON 解析。
 * Windows 下 claude 是 .cmd,SDK 的 resolveClaudeCodeExecutablePath 自动解析真实 exe,
 * 无需 cmd.exe /c 绕过。
 */

// SDK query 注入点:生产用真实 @anthropic-ai/claude-agent-sdk 的 query,测试注入桩。
// query 接收 {prompt, options},返回 AsyncIterable<SDKMessage>(消息对象,非原始 stream-json 行)。
export interface QueryFn {
  (params: { prompt: string; options: QueryOptions }): AsyncIterable<SDKMessage>;
}

// SDK Options 子集(仅我们用到的字段)
export interface QueryOptions {
  cwd?: string;
  resume?: string; // 存在则恢复该 session
  abortController?: AbortController;
  // 自动允许工具(网关作为自动化入口,不弹权限审批)
  // 生产可按需收敛为 allowedTools 白名单
  permissionMode?: "bypassPermissions" | "default" | "plan" | "acceptEdits";
}

// SDK 消息子集(仅我们消费的字段)
export interface SDKMessage {
  type: "system" | "assistant" | "user" | "result";
  subtype?: string;
  session_id?: string;
  result?: string;
  message?: { content?: Array<SDKContentBlock> };
}

export interface SDKContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  text?: string;
  thinking?: string;
  name?: string; // tool_use
  input?: unknown; // tool_use
  content?: string | unknown; // tool_result
}

export interface ClaudeAdapterOpts {
  query: QueryFn;
  permissionMode?: QueryOptions["permissionMode"];
}

export class ClaudeAdapter implements CliAdapter {
  type = "claude" as const;

  constructor(private opts: ClaudeAdapterOpts) {}

  async isAvailable(): Promise<boolean> {
    // SDK 内部解析 claude 可执行路径;此处简化为 true。
    // 生产可调 SDK 的 resolveClaudeCodeExecutablePath 探测。
    return true;
  }

  async start(opts: CliStartOpts): Promise<CliSession> {
    let sessionId: string | undefined = opts.sessionId;
    let abortController: AbortController | undefined;
    // 捕获到闭包,send 内部用 adapter 的依赖(对象字面量方法里 this 不可靠)
    const queryFn = this.opts.query;
    const permissionMode = this.opts.permissionMode ?? "bypassPermissions";
    const projectDir = opts.projectDir;

    return {
      get sessionId() { return sessionId; },
      kill: () => { abortController?.abort(); },
      async *send(text): AsyncGenerator<StreamChunk> {
        abortController = new AbortController();
        const q = queryFn({
          prompt: text,
          options: {
            cwd: projectDir,
            resume: sessionId,
            abortController,
            permissionMode,
          },
        });

        let hasResult = false;
        const assistantTexts: string[] = [];

        for await (const msg of q) {
          // 捕获 session_id(system/init 或任意消息携带)
          if (msg.session_id && !sessionId) sessionId = msg.session_id;

          if (msg.type === "assistant" && msg.message?.content) {
            for (const c of msg.message.content) {
              if (c.type === "thinking" && c.thinking) {
                yield { type: "thinking", text: c.thinking };
              } else if (c.type === "text" && c.text) {
                // 暂存:避免与 result.result 重复(同文本会同时出现在 assistant text 和 result.result)
                assistantTexts.push(c.text);
              } else if (c.type === "tool_use" || c.type === "tool_result") {
                yield { type: "tool", text: JSON.stringify(c) };
              }
            }
          }

          if (msg.type === "result" && msg.result !== undefined) {
            hasResult = true;
            yield { type: "final", text: msg.result };
          }
        }

        // fallback:无 result 消息(异常截断/进程被 kill)时用 assistant text 避免空回复
        if (!hasResult && assistantTexts.length > 0) {
          yield { type: "final", text: assistantTexts.join("") };
        }
      },
    };
  }
}
