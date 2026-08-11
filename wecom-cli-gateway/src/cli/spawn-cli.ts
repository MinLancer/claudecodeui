import { spawn, type ChildProcess } from "node:child_process";

/**
 * 共享的 CLI spawn 接口:cursor/opencode 都用 spawn CLI + 解析 stdout 行。
 * 注入点设计:测试用桩,生产用 realSpawnCli(child_process 封装)。
 *
 * Windows 注意:cursor/opencode 是 .cmd shim,child_process spawn 需 shell:true
 * 或直接 spawn .cmd 路径。realSpawnCli 用 shell:true 简化(prompt 作参数时引号转义由 shell 处理,
 * 但含特殊字符的 prompt 联调时需测)。
 */

export interface SpawnCliParams {
  cmd: string;
  args: string[];
  cwd: string;
  /** 写入子进程 stdin 的内容(若有);cursor/opencode prompt 作参数,通常不用 stdin */
  stdin?: string;
}

export interface SpawnedCli {
  /** stdout 按行产出(每行一个字符串,不含换行) */
  stdout: AsyncIterable<string>;
  /** 杀子进程 */
  kill(): void;
  /** 进程退出回调,返回 unsubscribe */
  onExit(cb: (code: number | null) => void): () => void;
}

export type SpawnCliFn = (params: SpawnCliParams) => SpawnedCli;

/** 生产实现:用 child_process spawn,stdout 按行迭代 */
export const realSpawnCli: SpawnCliFn = (params) => {
  // shell:true 让 Windows 找到 .cmd;prompt 作参数时 shell 负责引号
  const child = spawn(params.cmd, params.args, { cwd: params.cwd, shell: true });
  let lineBuffer = "";
  const lineQueue: string[] = [];
  const waiters: Array<() => void> = [];
  let stdoutEnded = false;
  let exitCode: number | null = null;
  const exitCbs: Array<(code: number | null) => void> = [];

  const pushLine = (line: string) => {
    if (line.length === 0) return;
    lineQueue.push(line);
    const w = waiters.shift();
    if (w) w();
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    lineBuffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = lineBuffer.indexOf("\n")) >= 0) {
      const line = lineBuffer.slice(0, idx).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(idx + 1);
      pushLine(line);
    }
  });
  child.stdout?.on("end", () => {
    if (lineBuffer) pushLine(lineBuffer);
    stdoutEnded = true;
    // 唤醒所有等待者(迭代结束)
    while (waiters.length) waiters.shift()!();
  });
  child.on("exit", (code) => {
    exitCode = code;
    for (const cb of exitCbs) cb(code);
    // 唤醒 stdout 迭代(可能 stdout end 晚于 exit)
    while (waiters.length) waiters.shift()!();
  });

  if (params.stdin) {
    child.stdin?.write(params.stdin);
    child.stdin?.end();
  }

  const stdout: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (lineQueue.length) yield lineQueue.shift()!;
        if (stdoutEnded || exitCode !== null) return;
        await new Promise<void>((r) => waiters.push(r));
      }
    },
  };

  return {
    stdout,
    kill: () => { child.kill(); },
    onExit: (cb) => {
      exitCbs.push(cb);
      if (exitCode !== null) cb(exitCode);
      return () => {
        const i = exitCbs.indexOf(cb);
        if (i >= 0) exitCbs.splice(i, 1);
      };
    },
  };
};
