export type IMPlatform = "wecom" | "dingtalk" | "feishu";

export interface NormalizedMessage {
  botId: string;
  msgId: string;
  chatSceneId: string; // "p2p:userId" 或 "group:groupId"
  userId: string;
  text: string;
}

export interface SendOpts {
  toUser: string;
  toChat?: string; // 群聊填群ID
  text: string;
  atUser?: string; // 群聊 @发言人
}

export interface IMAdapter {
  platform: IMPlatform;
  parseMessage(rawBody: Buffer, headers: object): Promise<NormalizedMessage | null>;
  sendMessage(opts: SendOpts): Promise<void>;
}
