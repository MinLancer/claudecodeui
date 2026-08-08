# 流式回复 + deploy.md 收尾 设计

## 背景

智能机器人流式回复只能走**被动回复**(回调响应里返回 stream,response_url 不支持流式)。
当前架构是 webhook 立即回 success + 异步执行 + response_url 一次性回复,与流式冲突。
方案:接收回调的被动响应用流式;主动回复(response_url)保留一次性 markdown。

## 流式协议(来自企微文档 101031)

1. 用户发消息 -> 企微 POST 回调(加密 JSON)
2. 开发者在**回调响应体**返回加密的 `{msgtype:"stream", stream:{id, finish:false, content:""}}`(首响应,content 可空)
3. 企微按 stream.id 持续推**刷新回调**(POST 同 URL,解密后 `{msgtype:"stream", stream:{id}}`)
4. 开发者在刷新回调响应返回加密的 `{msgtype:"stream", stream:{id, content:"最新内容", finish:false}}`(content 覆盖式)
5. claude 完成 -> 刷新回调返回 `finish:true`(可带图片,本期不带)
6. 6 分钟超时,企微停止推刷新

## 被动响应加密(文档 101033)

响应体格式:`{encrypt, msgsignature, timestamp, nonce}`,nonce 用回调请求的 nonce。
WeComCrypto 已有 encrypt + sign,复用。

## 架构改动

### 1. SessionStore 加流式状态存取(redis.ts)

```
stream:{streamId} = JSON {content, finish, error}
  - content: 当前累积的回复文本(覆盖式)
  - finish: 是否完成
  - error: 错误信息(若有)
TTL 400s(略大于 6 分钟超时)
```

新增方法:
- `setStreamChunk(streamId, content, finish): Promise<void>`(覆盖式写)
- `getStreamState(streamId): Promise<{content, finish, error} | null>`

RedisLike 接口加 `set(key, value, expiryMode, seconds)`(无 NX,用于覆盖写流式状态)。或复用现有 set 的 EX 重载--但当前 set 签名固定 NX。加一个不带 NX 的 set 重载或用 setex。

### 2. IMAdapter 接口扩展(types.ts)

```typescript
interface IMAdapter {
  parseMessage(rawBody, headers): Promise<NormalizedMessage | null>;
  sendMessage(opts: SendOpts): Promise<void>;  // 主动回复(response_url,保留)
  // 流式被动回复
  buildStreamResponse(streamId, content, finish, requestNonce): Promise<string>; // 返回加密响应体
}
```

NormalizedMessage 加 `streamId?: string`(刷新回调时携带,标识要拉哪个 stream)。

### 3. WeComAdapter 实现(wecom.ts)

- parseMessage:解密后判断 msgtype
  - `text`:用户消息,归一化(现有逻辑)+ 生成 streamId 存入消息(供首响应用)
  - `stream`:刷新回调,归一化为 `{msgtype:"stream_refresh", streamId}` 特殊消息
- buildStreamResponse:用 crypto.encrypt 加密 `{msgtype:"stream", stream:{id, content, finish}}`,包成 `{encrypt, msgsignature, timestamp, nonce}`

### 4. webhook 改造(webhook.ts)

POST 回调不再立即回 success,改为:
1. parseMessage 解析
2. 若用户消息(text):
   - 生成 streamId
   - 异步启动 router.handle(把 streamId 传入,router 执行 claude 时实时写 Redis)
   - 同步返回加密的 stream 首响应(content 空,finish:false)—— 5s 内
3. 若刷新回调(stream):
   - 从 Redis 拉 stream 状态
   - 同步返回加密的 stream 响应(content + finish)

### 5. router 改造(session-router.ts)

- RouterDeps 加 streamId(本次执行的 streamId)
- 执行 claude 时,不再攒齐 final,而是:
  - 每个 final/thinking chunk -> 累积到 content,写 Redis `setStreamChunk(streamId, content, false)`
  - claude 完成 -> `setStreamChunk(streamId, finalContent, true)`
  - 错误 -> `setStreamChunk(streamId, errorMsg, true)` + error 标志
- onReply(主动回复)仍保留,但本场景用户消息走流式不用 onReply

### 6. Non-stream 场景保留

- 白名单拒绝/锁占用/去重:这些在首响应前就要判断,首响应可直接返回对应提示(stream content=提示文本,finish=true)或仍用 response_url。简化:这些快速拒绝也走流式首响应(content=提示,finish=true),一轮就结束。

## deploy.md 收尾

更新部署文档:
- 凭证改为智能机器人 Token + EncodingAESKey(去掉 corpId/secret)
- 加 CLAUDE_AGENT_SDK_PATH 环境变量说明(SDK 路径,或 npm install 到本仓库)
- 加流式回复说明(6 分钟超时,首响应空 content)
- GET 验证 URL 说明
- 回调地址格式 /webhook/wecom/{botId}

## 文件改动清单

- src/store/redis.ts:加 stream 状态存取方法 + RedisLike set 重载
- src/im/types.ts:IMAdapter 加 buildStreamResponse,NormalizedMessage 加 streamId
- src/im/wecom.ts:parseMessage 区分 text/stream_refresh,加 buildStreamResponse
- src/server/webhook.ts:POST 改为流式首响应/刷新响应(不再回 success)
- src/router/session-router.ts:执行 claude 时实时写 Redis stream chunk
- src/index.ts:装配调整(parseMessage 返回类型、stream 状态存取注入)
- tests:更新 webhook/router/wecom 测试 + 加流式测试
- config.example.yaml:已更新(凭证字段)
- docs/deploy.md:更新凭证 + SDK 路径 + 流式说明

## TDD 顺序

1. redis.ts stream 状态存取(测试 FakeRedis set EX 重载)
2. wecom.ts buildStreamResponse + parseMessage 区分 stream_refresh
3. webhook.ts 流式首响应/刷新响应
4. router.ts 实时写 chunk
5. index.ts 装配
6. deploy.md
每步先写失败测试再实现。

## 风险/不确定

- 首响应空 content 企微是否接受(文档未明确,需真实联调验证;若不接受改占位"思考中...")
- 刷新回调频率由企微控制,可能跟不上 claude 产出(覆盖式保证最终一致,中间可能跳帧,可接受)
- 5s 首响应:parseMessage(解密)+ 生成 streamId + 存 Redis 初始状态 + 返回加密响应,应 <1s,无风险
- 流式 6 分钟超时:claude 执行超时 180s < 6 分钟,无冲突
