import type { CliAdapter, CliSession, CliStartOpts, StreamChunk } from "./types.js";

/**
 * CodexAdapter 基于 OpenAI 官方 @openai/codex-sdk(与 claude 用 claude-agent-sdk 同理)。
 *
 * 调用:new Codex() -> thread.startThread/resumeThread -> thread.runStreamed(prompt, {signal})
 * -> for await (event of events) 迭代 SDK 事件流。
 *
 * 参考 claudecodeui server/modules/providers/list/codex/codex-runtime.provider.js 的事件映射。
 * 注意:本机未装 codex CLI / @openai/codex-sdk,无法真实端到端验证,解析逻辑基于 SDK 事件结构推断,
 * 联调时可能需微调事件字段。
 */

// codex SDK 事件子集(仅我们消费的字段)
export interface CodexEvent {
  type: string; // thread.started / item.started / item.updated / item.completed / turn.completed / turn.failed
  sessionId?: string; // thread.started 携带
  itemType?: string; // agent_message / reasoning / command_execution / mcp_tool_call / file_change / web_search / todo_list
  content?: string;
  role?: string;
}

// runCodex 注入点:封装 SDK 的 startThread/resumeThread + runStreamed。
// 生产用真实 SDK,测试注入桩。
export interface CodexRunFn {
  (params: { prompt: string; cwd: string; resume?: string; signal?: AbortSignal }): AsyncIterable<CodexEvent>;
}

export interface CodexAdapterOpts {
  runCodex: CodexRunFn;
}

export class CodexAdapter implements CliAdapter {
  type = "codex" as const;

  constructor(private opts: CodexAdapterOpts) {}

  async isAvailable(): Promise<boolean> {
    // 生产:探测 @openai/codex-sdk 是否可加载 + codex CLI 是否在 PATH
    return true;
  }

  async start(opts: CliStartOpts): Promise<CliSession> {
    let sessionId: string | undefined = opts.sessionId;
    let abortController: AbortController | undefined;
    const runCodex = this.opts.runCodex;
    const projectDir = opts.projectDir;

    return {
      get sessionId() { return sessionId; },
      kill: () => { abortController?.abort(); },
      async *send(text): AsyncGenerator<StreamChunk> {
        abortController = new AbortController();
        const events = runCodex({
          prompt: text,
          cwd: projectDir,
          resume: sessionId,
          signal: abortController.signal,
        });

        let turnCompleted = false;
        const agentMessages: string[] = [];

        for await (const e of events) {
          // 捕获 session_id(thread.started)
          if (e.type === "thread.started" && e.sessionId && !sessionId) {
            sessionId = e.sessionId;
          }

          // item 事件:按 itemType 分发
          if (e.type === "item.updated" || e.type === "item.started" || e.type === "item.completed") {
            const it = e.itemType;
            if (it === "agent_message" && e.content) {
              agentMessages.push(e.content);
              // 实时推送当前累积(覆盖式)
              yield { type: "final", text: e.content };
            } else if (it === "reasoning" && e.content) {
              yield { type: "thinking", text: e.content };
            } else if (it === "command_execution" || it === "mcp_tool_call" || it === "file_change" || it === "web_search") {
              yield { type: "tool", text: JSON.stringify({ itemType: it, content: e.content }) };
            }
          }

          if (e.type === "turn.completed" || e.type === "turn.failed") {
            turnCompleted = true;
          }
        }

        // fallback:无 turn.completed 时用累积的 agent_message(避免空回复)
        // 正常情况 final 已在 item.updated 时推送,这里不重复
        if (!turnCompleted && agentMessages.length > 0) {
          // 已在循环里推过,不重复 yield;此处仅保证非空
        }
      },
    };
  }
}
