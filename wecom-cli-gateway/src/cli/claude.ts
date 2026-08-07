import type { CliAdapter, CliSession, CliStartOpts, StreamChunk } from "./types.js";

// PTY 注入点:生产用 node-pty,测试注入桩
export interface PtySpawner {
  spawn(cmd: string, args: string[], opts: { cwd: string }): Pty;
}
export interface Pty {
  write(data: string): void;
  kill(): void;
  onData(cb: (data: string) => void): () => void; // 返回 unsubscribe
  onExit(cb: (code: number | null) => void): () => void;
}

interface ClaudeStreamLine {
  type: string;
  session_id?: string;
  result?: string;
  subtype?: string;
  message?: { content?: Array<{ type: string; text?: string }> };
}

export class ClaudeAdapter implements CliAdapter {
  type = "claude" as const;

  constructor(private opts: { path: string }, private spawner: PtySpawner) {}

  async isAvailable(): Promise<boolean> {
    // 简单探测:which claude(跨平台用 process.platform 判断)
    return true; // 生产:execSync(`which ${path}`) 不抛即 true
  }

  async start(opts: CliStartOpts): Promise<CliSession> {
    const args = ["-p", "--output-format", "stream-json", "--input-format", "text"];
    if (opts.sessionId) {
      args.unshift("--resume", opts.sessionId);
    }
    const pty = this.spawner.spawn(this.opts.path, args, { cwd: opts.projectDir });

    let sessionId: string | undefined;
    const buffer: string[] = []; // 行缓冲

    return {
      get sessionId() { return sessionId; },
      kill: () => pty.kill(),
      async *send(text): AsyncGenerator<StreamChunk> {
        // 发送 prompt(claude -p 模式通过 stdin 或参数接收)
        pty.write(text + "\n");
        // 收集行,逐行解析
        const lines: string[] = [];
        let resolved = false;
        let resolveFn: () => void = () => {};
        const resolveOnce = () => { if (!resolved) { resolved = true; resolveFn(); } };
        const waiter = new Promise<void>((r) => { resolveFn = r; });

        // onData:累积行缓冲,收到 result 行即结束等待
        const offData = pty.onData((data: string) => {
          buffer.push(data);
          let joined = buffer.join("");
          const idx = joined.lastIndexOf("\n");
          if (idx >= 0) {
            const complete = joined.slice(0, idx);
            joined = joined.slice(idx + 1);
            buffer.length = 0;
            buffer.push(joined);
            for (const line of complete.split("\n")) {
              if (line.trim()) {
                lines.push(line);
                try {
                  const o = JSON.parse(line);
                  if (o.type === "result") resolveOnce();
                } catch { /* 非 JSON 行忽略 */ }
              }
            }
          }
        });

        // onExit:进程退出(崩溃/被 kill/正常退出)时结束等待,避免永久挂起
        const offExit = pty.onExit((_code: number | null) => {
          resolveOnce();
        });

        try {
          await waiter;
        } finally {
          // 清理监听器 + kill 进程(幂等,已死进程无妨)
          offData();
          offExit();
          pty.kill();
        }

        for (const line of lines) {
          let obj: ClaudeStreamLine;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.type === "system" && obj.session_id) sessionId = obj.session_id;
          if (obj.type === "assistant" && obj.message?.content) {
            for (const c of obj.message.content) {
              if (c.type === "text" && c.text) yield { type: "final", text: c.text };
            }
          }
          if (obj.type === "tool_use" || obj.type === "tool_result") {
            yield { type: "tool", text: JSON.stringify(obj) };
          }
          if (obj.type === "result" && obj.result) {
            yield { type: "final", text: obj.result };
          }
        }
      },
    };
  }
}
