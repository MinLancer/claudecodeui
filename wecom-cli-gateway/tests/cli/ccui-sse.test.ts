import { describe, it, expect } from "vitest";
import { parseSseEvents } from "../../src/cli/ccui-sse.js";

async function* fromBuffers(bufs: Buffer[]) {
  for (const b of bufs) yield b;
}

describe("parseSseEvents", () => {
  it("单 chunk 含完整事件", async () => {
    const input = Buffer.from(`data: ${JSON.stringify({ type: "status", message: "hi" })}\n\n`);
    const events = [];
    for await (const e of parseSseEvents(fromBuffers([input]))) events.push(e);
    expect(events).toEqual([{ type: "status", message: "hi" }]);
  });

  it("事件跨多个 chunk 边界", async () => {
    const json = JSON.stringify({ type: "done" });
    const part1 = Buffer.from(`data: ${json.slice(0, 5)}`);
    const part2 = Buffer.from(`${json.slice(5)}\n\n`);
    const events = [];
    for await (const e of parseSseEvents(fromBuffers([part1, part2]))) events.push(e);
    expect(events).toEqual([{ type: "done" }]);
  });

  it("多个事件在一个 chunk", async () => {
    const a = `data: ${JSON.stringify({ type: "session-id", sessionId: "s1" })}\n\n`;
    const b = `data: ${JSON.stringify({ type: "done" })}\n\n`;
    const events = [];
    for await (const e of parseSseEvents(fromBuffers([Buffer.from(a + b)]))) events.push(e);
    expect(events).toEqual([
      { type: "session-id", sessionId: "s1" },
      { type: "done" },
    ]);
  });

  it("非 JSON 的 data 行被跳过", async () => {
    const input = Buffer.from(`data: not-json\n\ndata: ${JSON.stringify({ type: "done" })}\n\n`);
    const events = [];
    for await (const e of parseSseEvents(fromBuffers([input]))) events.push(e);
    expect(events).toEqual([{ type: "done" }]);
  });

  it("无 type 字段的 JSON 被跳过", async () => {
    const input = Buffer.from(`data: ${JSON.stringify({ foo: "bar" })}\n\n`);
    const events = [];
    for await (const e of parseSseEvents(fromBuffers([input]))) events.push(e);
    expect(events).toEqual([]);
  });
});
