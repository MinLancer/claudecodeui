import type { CliAdapter, CliType } from "./types.js";
import type { AppConfig } from "../config/schema.js";
import type { QueryFn } from "./claude.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CursorAdapter } from "./cursor.js";
import { OpencodeAdapter } from "./opencode.js";
import { realSpawnCli } from "./spawn-cli.js";
import { CcuiAdapter, defaultFetchSse, type FetchSseFn } from "./ccui.js";

export interface BuildAdaptersDeps {
  claudeQuery: QueryFn;
  codexRun?: any;
  spawnCli: typeof realSpawnCli;
  fetchSse?: FetchSseFn;
}

export function buildCliAdapters(cfg: AppConfig, deps: BuildAdaptersDeps): Record<CliType, CliAdapter> {
  const ccui = cfg.clis.ccui;
  if (ccui) {
    const fetchSse = deps.fetchSse ?? defaultFetchSse;
    const make = (provider: CliType): CcuiAdapter =>
      new CcuiAdapter({
        baseUrl: ccui.baseUrl,
        apiKey: ccui.apiKey,
        provider,
        fetchSse,
        timeoutMs: ccui.timeoutMs,
      });
    return {
      claude: make("claude"),
      codex: make("codex"),
      cursor: make("cursor"),
      opencode: make("opencode"),
    };
  }
  // 旧适配器回退(保留备用)
  return {
    claude: new ClaudeAdapter({ query: deps.claudeQuery }),
    codex: new CodexAdapter({ runCodex: deps.codexRun }),
    cursor: new CursorAdapter({ spawnCli: deps.spawnCli }),
    opencode: new OpencodeAdapter({ spawnCli: deps.spawnCli }),
  };
}
