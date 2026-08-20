import type { CliSession, StreamChunk, CliType, CliAdapter, CliStartOpts } from "./types.js";
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
      // 自动化环境约束:企微无交互能力,阻止 claude 用 AskUserQuestion/ExitPlanMode 提问卡死。
      // 精简后作为消息后缀,每轮注入兜底;完整说明见远程 CLAUDE.md。
      const AUTO_MODE_PROMPT =
        "\n\n【自动化环境】auto mode 自主执行;禁止用 AskUserQuestion/ExitPlanMode 等交互式工具;需决策时自行判断继续。";
      const body = JSON.stringify({
        projectPath: this.opts.projectDir,
        message: `${text}${AUTO_MODE_PROMPT}`,
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
          console.log(`[ccui] 捕获上游 session-id provider=${this.opts.provider} projectDir=${this.opts.projectDir} sessionId=${ev.sessionId}`);
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
      // kill()/超时触发的 AbortError 不是错误内容,静默结束(与旧 ClaudeAdapter 行为一致)
      if (this.aborted) return;
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
