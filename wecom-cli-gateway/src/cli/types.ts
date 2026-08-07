export type CliType = "claude" | "codex" | "cursor" | "opencode";

export interface StreamChunk {
  type: "final" | "tool" | "thinking" | "error";
  text: string;
}

export interface CliSession {
  // 发送一条用户消息,异步迭代产出流式片段
  send(text: string): AsyncIterable<StreamChunk>;
  // 当前会话的 session_id(新建后才有值)
  readonly sessionId?: string;
  // 主动终止 CLI 进程
  kill(): void;
}

export interface CliStartOpts {
  projectDir: string;
  sessionId?: string; // 存在则 resume
}

export interface CliAdapter {
  type: CliType;
  isAvailable(): Promise<boolean>;
  start(opts: CliStartOpts): Promise<CliSession>;
}
