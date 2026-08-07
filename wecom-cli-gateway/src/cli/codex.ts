import type { CliAdapter, CliSession, CliStartOpts } from "./types.js";

// 预留:本期不实现。接入 codex 时实现 start/会话恢复/流式解析。
export class CodexAdapter implements CliAdapter {
  type = "codex" as const;
  async isAvailable(): Promise<boolean> { return false; }
  async start(_opts: CliStartOpts): Promise<CliSession> {
    throw new Error("CodexAdapter 未实现");
  }
}
