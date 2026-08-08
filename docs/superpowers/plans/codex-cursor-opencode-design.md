# codex/cursor/opencode 适配器实现 设计

## 背景

claudecodeui 调查结论:
- codex:官方 SDK `@openai/codex-sdk`(new Codex + startThread/resumeThread + runStreamed,事件流)
- cursor:spawn `cursor-agent` CLI + stream-json(每行 JSON,`-p <prompt> --output-format stream-json --resume=<id>`)
- opencode:spawn `opencode` CLI + json(`opencode run --format json --dir <wd> --session <id>`)

本机未装这三个 CLI,无法真实端到端验证(只能代码 + 桩测试)。诚实说明。

## 设计:统一注入点 + 各自解析

三个适配器都遵循 CliAdapter 接口(start 返回 CliSession,send 返回 AsyncIterable<StreamChunk>)。
差异在"如何驱动 CLI"和"如何解析输出",通过注入点隔离(测试用桩,生产用真实 SDK/spawn)。

### CodexAdapter(注入 SDK,类似 claude)

注入 `runCodex` 函数(封装 SDK 的 startThread/resumeThread + runStreamed):
```typescript
interface CodexRunFn {
  (params: { prompt: string; cwd: string; resume?: string; signal?: AbortSignal }): AsyncIterable<CodexEvent>;
}
```
CodexEvent 子集:type(item.started/updated/completed, turn.completed/failed, thread.started)、content、role 等。
send 遍历事件:
- agent_message item -> final(累积)
- reasoning item -> thinking
- command_execution/mcp_tool_call -> tool
- turn.completed -> 标记完成(若 SDK 不单独给 final,用累积的 agent_message)
- thread.started/sessionId 捕获 session_id

参考 claudecodeui 的 transformCodexEvent 的事件类型映射。

### CursorAdapter(注入 spawnCli,spawn + 行解析)

注入 `spawnCli` 函数:
```typescript
interface SpawnCliFn {
  (params: { cmd: string; args: string[]; cwd: string; input?: string }): {
    stdout: AsyncIterable<string>; // 每行
    kill(): void;
    onExit(cb: (code: number | null) => void): () => void;
  };
}
```
CursorAdapter.start 构造 args:`["-p", prompt, "--output-format", "stream-json", "-f"]` + `["--resume=<sid>"]` 若有。
注意:cursor 的 prompt 作参数(非 stdin),且 Windows 需去换行(claudecodeui 的 flattenPromptForWindowsShell)。
send 遍历 stdout 行,JSON.parse 后按 type 分发:
- system(subtype=init)-> 捕获 session_id
- assistant(message.content)-> text/thinking/tool_use
- result -> final
- 裸行(非 JSON)-> 当 stream delta 忽略或累积

### OpencodeAdapter(注入 spawnCli,同 cursor 模式)

注入同样的 spawnCli。args:`["run", "--format", "json", "--dir", projectDir, prompt]` + `["--session", sid]` 若有。
**prompt 作命令行参数**(opencode run [message..],非 stdin--官方文档确认)。
send 遍历 stdout 行,JSON.parse,按事件字段(sessionID/sessionId/content)分发。
session_id 从事件的 sessionID 字段捕获。
JSON 事件 schema 官方文档未展开,基于 claudecodeui 源码(sessionID/content 字段)推断,联调时微调。

### 共享 spawnCli 注入

cursor 和 opencode 都用 spawnCli 注入。生产用真实 child_process spawn 实现(封装成 spawnCliToJson),测试用桩。
但 cursor prompt 作参数、opencode prompt 作 stdin,差异在 args/input 构造,各自处理。spawnCli 通用(返回 stdout 行 + kill + onExit)。

注意:cursor/opencode 在 Windows 是 .cmd,child_process spawn 需 shell:true 或找 .cmd 路径(类似 claude 调查发现的)。生产 spawnCli 实现要处理 Windows .cmd。但这属于联调阶段,本期先写 spawnCli 接口 + 桩测试,生产实现用 child_process({shell:true}) 简化。

## 测试策略(本机无 CLI,纯桩测)

每个适配器注入桩 runCodex/spawnCli,返回固定事件/行,验证解析:
- CodexAdapter:桩返回固定 CodexEvent 序列,断言 final/thinking/tool/sessionId
- CursorAdapter:桩返回固定 stream-json 行,断言解析
- OpencodeAdapter:桩返回固定 json 行,断言解析
无法真实跑(无 CLI),在适配器注释和报告说明。

## index.ts 装配

- codex:loadCodexSdk() 动态 import @openai/codex-sdk(类似 loadClaudeQuery),若装了用真实,否则 isAvailable=false
- cursor:new CursorAdapter({ spawnCli: realSpawnCli })
- opencode:new OpencodeAdapter({ spawnCli: realSpawnCli })
- realSpawnCli 用 child_process 封装(spawn + stdout 行迭代 + kill + onExit)

## 文件改动

- src/cli/codex.ts:CodexAdapter(注入 runCodex)
- src/cli/cursor.ts:CursorAdapter(注入 spawnCli + stream-json 解析)
- src/cli/opencode.ts:OpencodeAdapter(注入 spawnCli + json 解析)
- src/cli/spawn-cli.ts:共享的 spawnCli 类型 + 生产实现(child_process 封装)
- src/index.ts:装配(loadCodexSdk + realSpawnCli)
- tests/cli/codex.test.ts, cursor.test.ts, opencode.test.ts:桩测试
- config.example.yaml:clis 段取消注释 codex/cursor/opencode

## TDD 顺序

1. CodexAdapter(注入 runCodex,桩测试事件解析)
2. spawn-cli.ts 共享类型 + 生产实现
3. CursorAdapter(注入 spawnCli,桩测试 stream-json 解析)
4. OpencodeAdapter(注入 spawnCli,桩测试 json 解析)
5. index.ts 装配
6. config.example.yaml 更新

## 风险

- 本机无 codex/cursor/opencode,无法真实验证解析逻辑是否匹配真实输出格式。基于 claudecodeui 源码的 event/line 结构推断,联调时可能需微调。
- codex SDK(@openai/codex-sdk)本机未装,loadCodexSdk 若找不到则 isAvailable=false(降级,不阻塞)。
- cursor/opencode Windows .cmd + shell:true 的引号/换行问题(prompt 含特殊字符),联调时需测。
