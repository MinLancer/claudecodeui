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
  // 流式刷新回调:企微按 stream.id 推刷新回调时,此字段标识要拉取的 streamId。
  // 普通用户消息此字段为空。webhook 据此区分处理。
  streamId?: string;
  // 事件回调:如企微用户当天首次进入单聊的 enter_chat 事件。
  // 事件无 response_url,webhook 据此走事件分支(被动文本回复),而非启动 CLI 会话。
  eventType?: "enter_chat";
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
  // 构造流式被动回复的加密响应体。
  // streamId: 本次流式回复的 id(首响应生成,刷新响应用回调里的)
  // content: 当前回复内容(覆盖式)
  // finish: 是否完成
  // requestNonce: 回调请求的 nonce(响应必须复用,企微校验)
  buildStreamResponse(streamId: string, content: string, finish: boolean, requestNonce: string): Promise<string>;
  // 构造被动文本回复的加密响应体(仅进入会话事件等支持文本被动回复的场景)。
  // 可选:未实现的平台(无此类事件)可省略。
  buildTextResponse?(content: string, requestNonce: string): Promise<string>;
}
