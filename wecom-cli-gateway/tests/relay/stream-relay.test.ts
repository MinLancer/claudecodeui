import { describe, it, expect } from "vitest";
import { StreamRelay } from "../../src/relay/stream-relay.js";

describe("StreamRelay.split", () => {
  it("短文本不拆分", () => {
    expect(StreamRelay.split("短回复", 100)).toEqual(["短回复"]);
  });

  it("超长文本按上限拆分", () => {
    const long = "a".repeat(250);
    const parts = StreamRelay.split(long, 100);
    expect(parts.length).toBe(3);
    expect(parts[0].length).toBe(100);
    expect(parts.join("")).toBe(long);
  });
});
