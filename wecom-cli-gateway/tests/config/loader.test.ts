import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config/loader.js";

describe("loadConfig", () => {
  it("加载合法的企微配置", () => {
    const path = join(tmpdir(), `cfg-${Date.now()}.yaml`);
    writeFileSync(path, `
server: { port: 3002, logLevel: info }
redis: { url: "redis://localhost:6379" }
bots:
  - id: wecom_1
    platform: wecom
    defaultCli: claude
    projectDir: /home/proj/app
    timeout: 180
    allowedUsers: [zhangsan]
    credentials: { corpId: c, secret: s, aesKey: a, token: t }
clis:
  claude: { path: claude }
`);
    const cfg = loadConfig(path);
    expect(cfg.server.port).toBe(3002);
    expect(cfg.bots[0].id).toBe("wecom_1");
    expect(cfg.bots[0].timeout).toBe(180);
    expect(cfg.bots[0].allowedUsers).toEqual(["zhangsan"]);
    expect(cfg.clis.claude.path).toBe("claude");
  });

  it("timeout 缺省时默认 180", () => {
    const path = join(tmpdir(), `cfg-${Date.now()}.yaml`);
    writeFileSync(path, `
server: { port: 3002, logLevel: info }
redis: { url: "redis://localhost:6379" }
bots:
  - id: wecom_1
    platform: wecom
    defaultCli: claude
    projectDir: /home/proj/app
    allowedUsers: []
    credentials: { corpId: c, secret: s, aesKey: a, token: t }
clis:
  claude: { path: claude }
`);
    const cfg = loadConfig(path);
    expect(cfg.bots[0].timeout).toBe(180);
  });

  it("非法 platform 抛错", () => {
    const path = join(tmpdir(), `cfg-${Date.now()}.yaml`);
    writeFileSync(path, `
server: { port: 3002, logLevel: info }
redis: { url: "redis://localhost:6379" }
bots:
  - id: b1
    platform: slack
    defaultCli: claude
    projectDir: /home/proj/app
    allowedUsers: []
    credentials: {}
clis:
  claude: { path: claude }
`);
    expect(() => loadConfig(path)).toThrow();
  });

  it("解析 clis.ccui 配置", () => {
    const path = join(tmpdir(), `cfg-${Date.now()}.yaml`);
    writeFileSync(path, `
server: { port: 3002, logLevel: info }
redis: { url: "redis://localhost:6379" }
bots:
  - id: wecom_1
    platform: wecom
    defaultCli: claude
    projectDir: /tmp/proj
    credentials: {}
clis:
  claude: { path: claude }
  ccui:
    baseUrl: http://localhost:3001
    apiKey: key-abc
`);
    const cfg = loadConfig(path);
    expect(cfg.clis.ccui?.baseUrl).toBe("http://localhost:3001");
    expect(cfg.clis.ccui?.apiKey).toBe("key-abc");
    expect(cfg.clis.ccui?.timeoutMs).toBe(600000);
  });

  it("ccui 缺失时 cfg.clis.ccui 为 undefined", () => {
    const path = join(tmpdir(), `cfg-${Date.now()}.yaml`);
    writeFileSync(path, `
server: { port: 3002, logLevel: info }
redis: { url: "redis://localhost:6379" }
bots:
  - id: wecom_1
    platform: wecom
    defaultCli: claude
    projectDir: /tmp/proj
    credentials: {}
clis:
  claude: { path: claude }
`);
    const cfg = loadConfig(path);
    expect(cfg.clis.ccui).toBeUndefined();
  });

  it("ccui.baseUrl 非法 URL 时 schema 报错", () => {
    const path = join(tmpdir(), `cfg-${Date.now()}.yaml`);
    writeFileSync(path, `
server: { port: 3002, logLevel: info }
redis: { url: "redis://localhost:6379" }
bots:
  - id: wecom_1
    platform: wecom
    defaultCli: claude
    projectDir: /tmp/proj
    credentials: {}
clis:
  claude: { path: claude }
  ccui:
    baseUrl: not-a-url
    apiKey: k
`);
    expect(() => loadConfig(path)).toThrow();
  });
});
