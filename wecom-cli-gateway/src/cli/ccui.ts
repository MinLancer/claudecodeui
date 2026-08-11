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
