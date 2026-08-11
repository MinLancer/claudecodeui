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
