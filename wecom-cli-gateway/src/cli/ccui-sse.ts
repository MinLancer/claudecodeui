// claudecodeui /api/agent 的 SSE 流解析。
// 事件格式(SSEStreamWriter.send):`data: ${JSON}\n\n`,多行 data 按 SSE 规范以 \n 拼接。
// 事件有两种类型字段(实证自真实 /api/agent 输出):
//   控制类用 `type`:status / session-id / done
//   消息类用 `kind`:session_created / thinking / tool_use / tool_result / text / status / complete

export type SseEvent = { type?: string; kind?: string; [key: string]: unknown };

export async function* parseSseEvents(chunks: AsyncIterable<Buffer>): AsyncIterable<SseEvent> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (dataLines.length === 0) continue;
      try {
        const parsed = JSON.parse(dataLines.join("\n"));
        // 有 type 或 kind 字段即视为事件(否则跳过非事件 JSON)
        if (parsed && typeof parsed === "object"
          && (typeof parsed.type === "string" || typeof parsed.kind === "string")) {
          yield parsed as SseEvent;
        }
      } catch {
        // 非 JSON data,跳过
      }
    }
  }
}

// 从 SSE 事件提取面向用户的最终回复文本。
// claude 真实格式(实证):`{kind:"text", role:"assistant", content}` 是最终回复。
// 另兼容 cursor-output / claude-response(其他 provider 或历史格式)。
export function extractText(event: SseEvent): string | null {
  const e = event as Record<string, unknown>;
  // claude 真实格式:assistant 的最终文本回复
  if (e.kind === "text" && e.role === "assistant" && typeof e.content === "string") {
    return e.content as string;
  }
  if (e.type === "claude-response" && e.data) {
    const data = e.data as Record<string, unknown>;
    const message = (data.message as Record<string, unknown>) || data;
    const content = message && (message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      let text = "";
      for (const item of content) {
        if (item && typeof item === "object"
          && (item as Record<string, unknown>).type === "text"
          && typeof (item as Record<string, unknown>).text === "string") {
          text += (item as Record<string, unknown>).text as string;
        }
      }
      return text || null;
    }
    return null;
  }
  if (e.type === "cursor-output" && typeof e.output === "string") {
    return e.output;
  }
  if (e.type === "text" && typeof e.text === "string") {
    return e.text;
  }
  return null;
}
