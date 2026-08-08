import Fastify from "fastify";
import { registerWebhook, type WebhookDeps } from "./webhook.js";

export interface AppDeps {
  parseMessage: (body: Buffer, headers: object, botId: string, platform: string) => Promise<any>;
  routerHandle: (msg: any) => Promise<void>;
  verifyUrl?: (query: Record<string, string>, botId: string, platform: string) => Promise<string | null>;
}

export function createApp(deps: AppDeps) {
  const app = Fastify({ logger: true });
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  registerWebhook(app, deps);
  return app;
}
