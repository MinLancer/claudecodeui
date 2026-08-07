import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { AppConfigSchema, type AppConfig } from "./schema.js";

export function loadConfig(path: string): AppConfig {
  const raw = readFileSync(path, "utf8");
  const obj = parse(raw);
  return AppConfigSchema.parse(obj);
}
