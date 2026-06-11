import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  type GroupMetadata,
  type WAMessage,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import {
  authDir,
  loadConfig,
  saveGroups,
  dataDir,
  type DiscoveredGroup,
} from "./config.js";
import { appendFile, mkdir, stat, rename, readFile } from "node:fs/promises";
import path from "node:path";
import { StatsStore } from "./stats.js";

export interface StoredMessage {
  id: string;
  text: string;
  timestamp: number;
  sender: string;
  groupId: string;
  groupName: string;
}

export class WhatsappMonitor {
  readonly stats = new StatsStore();

  private readonly messages: StoredMessage[] = [];
  private readonly groups = new Map<string, DiscoveredGroup>();
  private readonly groupMetadataCache = new Map<string, GroupMetadata>();
  private _sock: ReturnType<typeof makeWASocket> | null = null;

  async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = this._sock = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: "silent" }),
      cachedGroupMetadata: async (groupId) =>
        this.groupMetadataCache.get(groupId),
    });

    // Load persisted messages into memory so API has history even after restarts
    try {
      await this.loadPersistedMessages(2000);
    } catch (e) {
      console.warn('Could not load persisted messages at startup:', e);
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log("QR generated. Scan it from WhatsApp Linked Devices.");
        qrcode.generate(qr, { small: true });
      }

      if (connection) {
        console.log(`WhatsApp connection status: ${connection}`);
      }

      if (connection === "open") {
        try {
          await this.discoverGroups(sock);
        } catch (error) {
          console.warn("Could not discover WhatsApp groups; continuing message capture.", error);
        }
      }

      if (connection === "close") {
        const disconnectError = lastDisconnect?.error as Boom | undefined;
        const statusCode = disconnectError?.output?.statusCode;

        console.warn("WhatsApp connection closed.", {
          statusCode,
          reason: disconnectError?.message,
        });

        if (statusCode !== DisconnectReason.loggedOut) {
          console.log("WhatsApp disconnected; reconnecting.");
          void this.connect();
        } else {
          console.log("WhatsApp session logged out. Remove data/auth to log in again.");
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      console.log(`Received WhatsApp message upsert: ${type} (${messages.length}).`);

      for (const message of messages) {
        await this.handleMessage(message);
      }
    });
  }

  getSock(): ReturnType<typeof makeWASocket> | null { return this._sock; }

  getAllParticipants(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const meta of this.groupMetadataCache.values()) {
      for (const p of meta.participants ?? []) {
        if (p.jid) map[p.id] = p.jid;
      }
    }
    return map;
  }

  getGroupMetadataWithParticipants(groupId: string): Promise<GroupMetadata | null> {
    return this._sock?.groupMetadata(groupId) ?? Promise.resolve(null);
  }

  getGroups(): DiscoveredGroup[] {
    return [...this.groups.values()];
  }

  getListings(limit: number): StoredMessage[] {
    return this.messages.slice(-Math.max(0, limit));
  }

  // Load persisted messages from data/messages.jsonl into memory on startup
  private async loadPersistedMessages(limit = 1000): Promise<void> {
    const messagesPath = path.join(dataDir, 'messages.jsonl');
    try {
      const raw = await readFile(messagesPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = lines.map((l) => {
        try { return JSON.parse(l) as StoredMessage; } catch { return null; }
      }).filter((x): x is StoredMessage => x !== null);
      const tail = parsed.slice(-limit);
      this.messages.push(...tail);
      for (const m of tail) this.stats.record(m);
      console.log(`Loaded ${tail.length} persisted messages from ${messagesPath}`);
    } catch (e: any) {
      if (e.code !== 'ENOENT') console.warn('Failed to load persisted messages:', e);
    }
  }

  private async appendPersistedMessage(m: StoredMessage): Promise<void> {
    const messagesPath = path.join(dataDir, 'messages.jsonl');
    const archiveDir = path.join(dataDir, 'archive');
    try {
      // Rotate if bigger than 100MB
      try {
        const s = await stat(messagesPath).catch(() => null);
        if (s && s.size > 100 * 1024 * 1024) {
          await mkdir(archiveDir, { recursive: true });
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          await rename(messagesPath, path.join(archiveDir, `messages-${ts}.jsonl`));
          console.log(`Rotated messages.jsonl to archive/messages-${ts}.jsonl`);
        }
      } catch (e) {
        console.warn('Rotation check failed:', e);
      }

      await appendFile(messagesPath, JSON.stringify(m) + '\n', 'utf8');
    } catch (err) {
      console.error('Failed to append persisted message:', err);
    }
  }

  private async discoverGroups(sock: ReturnType<typeof makeWASocket>): Promise<void> {
    console.log("Discovering WhatsApp groups.");
    const groupMetadata = await sock.groupFetchAllParticipating();
    const groups = Object.values(groupMetadata).map((metadata) => {
      this.groupMetadataCache.set(metadata.id, metadata);

      const group = {
        id: metadata.id,
        name: metadata.subject,
      };

      this.groups.set(group.id, group);
      console.log("Discovered group:", group);
      return group;
    });

    await saveGroups(groups);
    console.log(`Saved ${groups.length} groups to data/groups.json.`);
  }

  private async handleMessage(message: WAMessage): Promise<void> {
    const remote = message.key.remoteJid;
    const text = extractText(message);

    // ignore messages without content or id
    if (!remote || !text || !message.key.id) return;
    if (isStatusBroadcast(remote)) {
      console.log(`Ignoring WhatsApp status message ${message.key.id}.`);
      return;
    }

    const isGroup = typeof remote === 'string' && remote.endsWith('@g.us');

    const config = await loadConfig();
    if (isGroup && config.monitoredGroups.length > 0 && !config.monitoredGroups.includes(remote)) {
      // monitoredGroups only applies to groups; DMs are always collected
      return;
    }

    const groupName = isGroup
      ? this.groupMetadataCache.get(remote)?.subject ?? this.groups.get(remote)?.name ?? remote
      : `DM:${message.key.participant ?? remote}`;

    const timestamp = timestampToMs(message.messageTimestamp);
    const storedMessage: StoredMessage = {
      id: message.key.id,
      text,
      timestamp,
      sender: message.key.participant ?? (isGroup ? 'unknown' : remote),
      groupId: remote,
      groupName,
    };

    console.log(`Incoming ${isGroup ? 'group' : 'DM'} message [${groupName}]: ${text}`);

    // Append to in-memory store
    this.messages.push(storedMessage);
    this.stats.record(storedMessage);

    // Persist to disk as JSONL
    try {
      await this.appendPersistedMessage(storedMessage);
      console.log(`Persisted message ${storedMessage.id}`);
    } catch (e) {
      console.error('Failed to persist message:', e);
    }

    console.log(`Stored message ${storedMessage.id} from ${storedMessage.sender}.`);
  }
}

function isStatusBroadcast(remoteJid: string): boolean {
  return remoteJid === 'status@broadcast';
}

function extractText(message: WAMessage): string | undefined {
  const content = message.message;

  return (
    content?.conversation ??
    content?.extendedTextMessage?.text ??
    content?.imageMessage?.caption ??
    content?.videoMessage?.caption ??
    undefined
  )?.trim();
}

function timestampToMs(timestamp: WAMessage["messageTimestamp"]): number {
  if (typeof timestamp === "number") {
    return timestamp * 1000;
  }

  if (typeof timestamp === "object" && timestamp !== null) {
    return timestamp.toNumber() * 1000;
  }

  return Date.now();
}
