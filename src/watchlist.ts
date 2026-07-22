import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { request } from "node:https";
import path from "node:path";
import { dataDir } from "./config.js";
import { matchesKeyword, normalizeText } from "./filters.js";
import type { MetricSample } from "./metrics.js";
import type { StoredMessage } from "./whatsapp.js";

export interface WatchDefinition {
  id: string;
  enabled: boolean;
  groupIds: string[];
  keywords: string[];
  excludeKeywords?: string[];
  telegramChatId?: string;
  telegramTopicId?: number;
}

interface WatchlistConfig {
  watches: WatchDefinition[];
}

interface AlertRecord {
  watchId: string;
  messageId: string;
  groupId: string;
  sentAt: number;
  matchedKeywords: string[];
  status: "sent" | "failed" | "dry_run";
  error?: string;
}

interface TelegramResponse {
  ok?: boolean;
  description?: string;
}

const watchlistPath = path.join(dataDir, "watchlist.json");
const alertsPath = path.join(dataDir, "watch-alerts.jsonl");

const emptyConfig: WatchlistConfig = { watches: [] };

export class WatchlistService {
  private config: WatchlistConfig = emptyConfig;
  private configMtimeMs = 0;
  private loadedAlerts = false;
  private readonly alertedKeys = new Set<string>();
  private readonly matchesTotal = new Map<string, number>();
  private readonly alertsTotal = new Map<string, number>();
  private readonly failuresTotal = new Map<string, number>();
  private lastMatchTimestampMs = 0;

  async initialize(): Promise<void> {
    await this.loadConfigIfChanged();
    await this.loadAlertStateOnce();
  }

  async process(message: StoredMessage): Promise<void> {
    await this.loadConfigIfChanged();
    await this.loadAlertStateOnce();

    for (const watch of this.config.watches) {
      if (!watch.enabled || !watch.groupIds.includes(message.groupId)) {
        continue;
      }

      const matchedKeywords = matchingKeywords(message.text, watch.keywords);
      if (matchedKeywords.length === 0 || matchesKeyword(message.text, watch.excludeKeywords ?? [])) {
        continue;
      }

      this.increment(this.matchesTotal, { watch_id: watch.id, group_id: message.groupId });
      this.lastMatchTimestampMs = Date.now();

      const alertKey = keyFor(watch.id, message.groupId, message.id);
      if (this.alertedKeys.has(alertKey)) {
        continue;
      }

      const result = await this.sendAlert(watch, message, matchedKeywords);
      if (result.status !== "failed") {
        this.alertedKeys.add(alertKey);
      }
      await this.recordAlert({
        watchId: watch.id,
        messageId: message.id,
        groupId: message.groupId,
        sentAt: Date.now(),
        matchedKeywords,
        status: result.status,
        error: result.error,
      });
    }
  }

  samples(): MetricSample[] {
    const samples: MetricSample[] = [
      {
        name: "whatsapp_watchlist_enabled_watches",
        help: "Number of enabled watchlist definitions.",
        type: "gauge",
        value: this.config.watches.filter((watch) => watch.enabled).length,
      },
      {
        name: "whatsapp_watchlist_last_match_timestamp_seconds",
        help: "Unix timestamp of the latest watchlist keyword match.",
        type: "gauge",
        value: this.lastMatchTimestampMs > 0 ? this.lastMatchTimestampMs / 1000 : 0,
      },
    ];

    for (const [labels, value] of this.matchesTotal) {
      samples.push({
        name: "whatsapp_watchlist_matches_total",
        help: "Total watchlist keyword matches.",
        type: "counter",
        value,
        labels: JSON.parse(labels),
      });
    }
    for (const [labels, value] of this.alertsTotal) {
      samples.push({
        name: "whatsapp_watchlist_alerts_total",
        help: "Total watchlist alert delivery attempts by status.",
        type: "counter",
        value,
        labels: JSON.parse(labels),
      });
    }
    for (const [labels, value] of this.failuresTotal) {
      samples.push({
        name: "whatsapp_watchlist_alert_failures_total",
        help: "Total watchlist alert delivery failures.",
        type: "counter",
        value,
        labels: JSON.parse(labels),
      });
    }

    return samples;
  }

  private async loadConfigIfChanged(): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    try {
      const currentStat = await stat(watchlistPath);
      if (currentStat.mtimeMs === this.configMtimeMs) {
        return;
      }

      const raw = await readFile(watchlistPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WatchlistConfig>;
      this.config = {
        watches: Array.isArray(parsed.watches)
          ? parsed.watches.map(parseWatch).filter((watch): watch is WatchDefinition => watch !== null)
          : [],
      };
      this.configMtimeMs = currentStat.mtimeMs;
      console.log(`Loaded ${this.config.watches.length} watchlist rule(s).`);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        await writeFile(watchlistPath, `${JSON.stringify(emptyConfig, null, 2)}\n`, "utf8");
        this.config = emptyConfig;
        this.configMtimeMs = 0;
        return;
      }
      console.warn("Could not read data/watchlist.json; watchlist alerts disabled.", error);
      this.config = emptyConfig;
    }
  }

  private async loadAlertStateOnce(): Promise<void> {
    if (this.loadedAlerts) {
      return;
    }
    this.loadedAlerts = true;

    try {
      const raw = await readFile(alertsPath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as Partial<AlertRecord>;
          if (
            record.watchId
            && record.groupId
            && record.messageId
            && record.status !== "failed"
          ) {
            this.alertedKeys.add(keyFor(record.watchId, record.groupId, record.messageId));
          }
        } catch {
          continue;
        }
      }
      console.log(`Loaded ${this.alertedKeys.size} watchlist alert dedupe key(s).`);
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        console.warn("Could not load watchlist alert state.", error);
      }
    }
  }

  private async sendAlert(
    watch: WatchDefinition,
    message: StoredMessage,
    matchedKeywords: string[],
  ): Promise<{ status: AlertRecord["status"]; error?: string }> {
    const text = renderAlert(watch, message, matchedKeywords);
    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = watch.telegramChatId ?? process.env.TELEGRAM_CHAT_ID?.trim();
    const topicId = watch.telegramTopicId ?? numberFromEnv("TELEGRAM_TOPIC_ID");

    if (process.env.WATCHLIST_DRY_RUN === "true" || process.env.WATCHLIST_DRY_RUN === "1") {
      console.log(`WATCHLIST_DRY_RUN alert:\n${text}`);
      this.increment(this.alertsTotal, { watch_id: watch.id, status: "dry_run" });
      return { status: "dry_run" };
    }

    if (!botToken || !chatId) {
      const error = "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID before watchlist alerts can be sent";
      console.warn(error);
      this.increment(this.alertsTotal, { watch_id: watch.id, status: "failed" });
      this.increment(this.failuresTotal, { watch_id: watch.id, reason: "missing_telegram_config" });
      return { status: "failed", error };
    }

    try {
      await sendTelegram(botToken, {
        chat_id: chatId,
        message_thread_id: topicId,
        text,
      });
      this.increment(this.alertsTotal, { watch_id: watch.id, status: "sent" });
      return { status: "sent" };
    } catch (error: any) {
      const messageText = error?.message ?? String(error);
      console.warn(`Watchlist alert delivery failed for ${watch.id}:`, messageText);
      this.increment(this.alertsTotal, { watch_id: watch.id, status: "failed" });
      this.increment(this.failuresTotal, { watch_id: watch.id, reason: "send_error" });
      return { status: "failed", error: messageText };
    }
  }

  private async recordAlert(record: AlertRecord): Promise<void> {
    await appendFile(alertsPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  private increment(map: Map<string, number>, labels: Record<string, string>): void {
    const key = JSON.stringify(labels);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
}

function parseWatch(value: unknown): WatchDefinition | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const groupIds = stringArray(value.groupIds);
  const keywords = stringArray(value.keywords);
  if (!id || groupIds.length === 0 || keywords.length === 0) {
    return null;
  }

  return {
    id,
    enabled: value.enabled !== false,
    groupIds,
    keywords,
    excludeKeywords: stringArray(value.excludeKeywords),
    telegramChatId: typeof value.telegramChatId === "string" && value.telegramChatId.trim()
      ? value.telegramChatId.trim()
      : undefined,
    telegramTopicId: typeof value.telegramTopicId === "number" && Number.isSafeInteger(value.telegramTopicId)
      ? value.telegramTopicId
      : undefined,
  };
}

function matchingKeywords(text: string, keywords: string[]): string[] {
  const normalizedText = normalizeText(text);
  return keywords.filter((keyword) => normalizedText.includes(normalizeText(keyword)));
}

function renderAlert(watch: WatchDefinition, message: StoredMessage, matchedKeywords: string[]): string {
  const sender = message.senderName ? `${message.senderName} (${message.sender})` : message.sender;
  const when = new Date(message.timestamp).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
  return [
    `Watchlist match: ${watch.id}`,
    "",
    `Group: ${message.groupName}`,
    `From: ${sender}`,
    `Matched: ${matchedKeywords.join(", ")}`,
    `Time: ${when}`,
    "",
    message.text,
  ].join("\n").slice(0, 3900);
}

function sendTelegram(
  botToken: string,
  payload: { chat_id: string; message_thread_id?: number; text: string },
): Promise<void> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "api.telegram.org",
        path: `/bot${botToken}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: (numberFromEnv("TELEGRAM_TIMEOUT_SECONDS") ?? 30) * 1000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const responseText = Buffer.concat(chunks).toString("utf8");
          let parsed: TelegramResponse = {};
          try {
            parsed = JSON.parse(responseText) as TelegramResponse;
          } catch {
            // Telegram normally returns JSON; keep the raw status when it does not.
          }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && parsed.ok !== false) {
            resolve();
            return;
          }
          reject(new Error(parsed.description ?? `Telegram HTTP ${res.statusCode}: ${responseText}`));
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Telegram request timed out")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function numberFromEnv(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function keyFor(watchId: string, groupId: string, messageId: string): string {
  return `${watchId}\t${groupId}\t${messageId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
