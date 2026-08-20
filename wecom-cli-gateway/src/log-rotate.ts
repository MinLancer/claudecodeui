import { Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";

// 日期串:yyyy-MM-dd
function dayStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 按天滚动的 Writable 流:把写入内容追加到 {dir}/{prefix}-{yyyy-MM-dd}.log,
// 跨天自动切换新文件。用于网关按天滚动日志(替代单文件 gateway.log)。
// 采用同步 fs.writeSync,每次写入立即落盘,进程崩溃也不丢日志。
export class DailyRotateStream extends Writable {
  private fd: number | null = null;
  private day = "";

  constructor(private dir: string, private prefix: string) {
    super();
  }

  private open(d: string): void {
    if (this.fd !== null && d === this.day) return;
    if (this.fd !== null) fs.closeSync(this.fd);
    this.day = d;
    fs.mkdirSync(this.dir, { recursive: true });
    this.fd = fs.openSync(path.join(this.dir, `${this.prefix}-${d}.log`), "a");
  }

  _write(chunk: Buffer, _enc: string, cb: (e?: Error | null) => void): void {
    try {
      this.open(dayStr(new Date()));
      fs.writeSync(this.fd!, chunk);
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }

  _final(cb: (e?: Error | null) => void): void {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
    cb();
  }
}
