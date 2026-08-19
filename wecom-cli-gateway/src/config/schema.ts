import { z } from "zod";

export const CliConfigSchema = z.object({
  path: z.string().default("claude"),
});

// 桥接 claudecodeui 的外部 API(自托管模式 x-api-key 认证)
export const CcuiConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  timeoutMs: z.number().int().positive().default(600000),
});

export const BotCredentialsSchema = z.record(z.string(), z.string()).default({});

export const BotConfigSchema = z.object({
  id: z.string(),
  platform: z.enum(["wecom", "dingtalk", "feishu"]),
  defaultCli: z.enum(["claude", "codex", "cursor", "opencode"]).default("claude"),
  projectDir: z.string(),
  timeout: z.number().int().positive().default(180),
  allowedUsers: z.array(z.string()).default([]),
  credentials: BotCredentialsSchema,
  cliSwitchPrefix: z.string().optional(),
  // 进入会话(enter_chat)欢迎语:用户当天首次进入单聊时被动文本回复。不填用默认文案。
  enterGreeting: z.string().optional(),
});

export const AppConfigSchema = z.object({
  server: z.object({
    port: z.number().int().positive().default(3002),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }).default({ port: 3002, logLevel: "info" }),
  redis: z.object({
    url: z.string(),
  }),
  bots: z.array(BotConfigSchema).min(1),
  clis: z.object({
    claude: CliConfigSchema.default({ path: "claude" }),
    codex: CliConfigSchema.optional(),
    cursor: CliConfigSchema.optional(),
    opencode: CliConfigSchema.optional(),
    ccui: CcuiConfigSchema.optional(),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type BotConfig = z.infer<typeof BotConfigSchema>;
export type CcuiConfig = z.infer<typeof CcuiConfigSchema>;
