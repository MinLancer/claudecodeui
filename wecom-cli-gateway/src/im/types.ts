export type IMPlatform = "wecom" | "dingtalk" | "feishu";

export interface NormalizedMessage {
  botId: string;
  msgId: string;
  chatSceneId: string; // "p2p:userId" 或 "group:groupId"
  userId: string;
  text: string;
  // 企微智能机器人:回调携带的临时回复 URL(1 小时有效,仅可用 1 次)。
  // 其他 IM 若无此机制则为空,sendMessage 另走平台主动消息 API。
  responseUrl?: string;
}

export interface SendOpts {
  toUser: string;
  toChat?: string; // 群聊填群ID
  text: string;
  atUser?: string; // 群聊 @发言人
  responseUrl?: string; // 企微智能机器人回复用
}

export interface IMAdapter {
  platform: IMPlatform;
  parseMessage(rawBody: Buffer, headers: object): Promise<NormalizedMessage | null>;
  sendMessage(opts: SendOpts): Promise<void>;
}
