import type { IMAdapter, NormalizedMessage, SendOpts } from "./types.js";

// 预留:本期不实现。接入钉钉时在此实现 parseMessage/sendMessage。
export class DingtalkAdapter implements IMAdapter {
  platform = "dingtalk" as const;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async parseMessage(_rawBody: Buffer, _headers: object): Promise<NormalizedMessage | null> {
    throw new Error("DingtalkAdapter 未实现");
  }
  async sendMessage(_opts: SendOpts): Promise<void> {
    throw new Error("DingtalkAdapter 未实现");
  }
  async buildStreamResponse(_streamId: string, _content: string, _finish: boolean, _requestNonce: string): Promise<string> {
    throw new Error("DingtalkAdapter 未实现");
  }
}
