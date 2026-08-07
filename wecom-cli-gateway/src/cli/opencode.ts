import type { CliAdapter, CliSession, CliStartOpts } from "./types.js";

// 预留:本期不实现。接入 opencode 时实现 start/会话恢复/流式解析。
export class OpencodeAdapter implements CliAdapter {
  type = "opencode" as const;
  async isAvailable(): Promise<boolean> { return false; }
  async start(_opts: CliStartOpts): Promise<CliSession> {
    throw new Error("OpencodeAdapter 未实现");
  }
}
