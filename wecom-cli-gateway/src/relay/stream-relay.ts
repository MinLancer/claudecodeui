export class StreamRelay {
  // 按上限分段;企微文本消息上限约 2048,留余量用 1900
  static split(text: string, maxLen = 1900): string[] {
    if (text.length <= maxLen) return [text];
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) {
      parts.push(text.slice(i, i + maxLen));
    }
    return parts;
  }
}
