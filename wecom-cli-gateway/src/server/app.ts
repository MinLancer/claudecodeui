import Fastify from "fastify";
import { registerWebhook, type WebhookDeps } from "./webhook.js";

export interface AppDeps {
  parseMessage: (body: Buffer, headers: object, botId: string, platform: string) => Promise<any>;
  handleUserMessage: (msg: any) => Promise<string | null>;
  getStreamState: (streamId: string) => Promise<{ content: string; finish: boolean } | null>;
  buildStreamResponse: (streamId: string, content: string, finish: boolean, requestNonce: string) => Promise<string>;
  handleEvent?: (msg: any) => Promise<string | null>;
  buildTextResponse?: (content: string, requestNonce: string) => Promise<string>;
  verifyUrl?: (query: Record<string, string>, botId: string, platform: string) => Promise<string | null>;
}

export function createApp(deps: AppDeps) {
  // logger 用 process.stdout 流而非默认 fd 1:这样 pino 走 process.stdout.write,
  // 网关入口接管 stdout 后能一并写入按天滚动日志;测试/未接管时回落到真实 stdout。
  const app = Fastify({ logger: { level: "info", stream: process.stdout } });
  // 企微回调 body 是加密 JSON,parseMessage 需要原始 Buffer。
  // Fastify 内置 application/json / text/plain parser 会优先于通配符 "*" 把 body 解析成对象,
  // 导致 parseMessage 收到对象、JSON.parse("[object Object]") 失败返回 null,网关永远回 success。
  // 先移除内置 parser,再用通配符强制所有请求以原始 Buffer 处理。
  app.removeContentTypeParser("application/json");
  app.removeContentTypeParser("text/plain");
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  registerWebhook(app, deps);
  return app;
}
