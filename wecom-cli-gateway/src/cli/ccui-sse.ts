// claudecodeui /api/agent 的 SSE 流解析。
// 事件格式(SSEStreamWriter.send):`data: ${JSON}\n\n`,多行 data 按 SSE 规范以 \n 拼接。

export type SseEvent = { type: string; data?: unknown };

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
        if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
          yield parsed as SseEvent;
        }
      } catch {
        // 非 JSON data,跳过
      }
    }
  }
}

// 从 SSE 事件提取面向用户的文本。
// 依据:claudecodeui server/modules/git/git.routes.ts:1051-1063 的真实消费逻辑。
export function extractText(event: SseEvent): string | null {
  const e = event as Record<string, unknown>;
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
