import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface MonitorConfig {
  monitoredGroups: string[];
}

export interface DiscoveredGroup {
  id: string;
  name: string;
}

export const dataDir = path.resolve(process.cwd(), "data");
export const authDir = path.join(dataDir, "auth");
const configPath = path.join(dataDir, "config.json");
const groupsPath = path.join(dataDir, "groups.json");

const emptyConfig: MonitorConfig = { monitoredGroups: [] };

export async function ensureDataFiles(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeJsonIfMissing(configPath, emptyConfig);
  await writeJsonIfMissing(groupsPath, []);
}

export async function loadConfig(): Promise<MonitorConfig> {
  try {
    const rawConfig = await readFile(configPath, "utf8");
    const parsedConfig = JSON.parse(rawConfig) as Partial<MonitorConfig>;

    return {
      monitoredGroups: Array.isArray(parsedConfig.monitoredGroups)
        ? parsedConfig.monitoredGroups.filter(
            (groupId): groupId is string => typeof groupId === "string",
          )
        : [],
    };
  } catch (error) {
    console.warn("Could not read data/config.json; processing all groups.", error);
    return emptyConfig;
  }
}

export async function saveGroups(groups: DiscoveredGroup[]): Promise<void> {
  await writeFile(groupsPath, `${JSON.stringify(groups, null, 2)}\n`, "utf8");
}

async function writeJsonIfMissing(filePath: string, value: unknown): Promise<void> {
  try {
    await readFile(filePath, "utf8");
  } catch {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}
