import type { CliAdapter, CliSession, CliStartOpts } from "./types.js";

// 预留:本期不实现。接入 cursor 时实现 start/会话恢复/流式解析。
export class CursorAdapter implements CliAdapter {
  type = "cursor" as const;
  async isAvailable(): Promise<boolean> { return false; }
  async start(_opts: CliStartOpts): Promise<CliSession> {
    throw new Error("CursorAdapter 未实现");
  }
}
