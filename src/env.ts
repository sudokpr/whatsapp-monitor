import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadLocalEnv(filePath = path.resolve(process.cwd(), ".env")): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not load ${filePath}.`, error);
    }
    return;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (process.env[key]) {
      continue;
    }

    const value = parseEnvValue(key, rawValue.trim());
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

function parseEnvValue(key: string, rawValue: string): string | undefined {
  const defaultPattern = new RegExp(`^\\$\\{${escapeRegExp(key)}:-(.*)\\}$`);
  const defaultMatch = defaultPattern.exec(rawValue);
  if (defaultMatch) {
    return unquote(defaultMatch[1]);
  }
  return unquote(rawValue);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
