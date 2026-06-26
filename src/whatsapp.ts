import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  type GroupMetadata,
  type WAMessage,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import {
  getContentType,
  normalizeMessageContent,
} from "@whiskeysockets/baileys/lib/Utils/messages.js";
import {
  downloadContentFromMessage,
} from "@whiskeysockets/baileys/lib/Utils/messages-media.js";
import type { MediaType } from "@whiskeysockets/baileys/lib/Types/index.js";
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
import type { MetricSample } from "./metrics.js";

export interface StoredMessage {
  id: string;
  text: string;
  timestamp: number;
  sender: string;
  senderName?: string;
  groupId: string;
  groupName: string;
  media?: StoredMedia;
}

export interface StoredMedia {
  type: "image" | "video" | "document" | "audio" | "sticker";
  mediaKey: string;
  directPath?: string;
  url?: string;
  mimeType?: string;
  fileName?: string;
  fileLength?: number;
}

export interface MediaDownload {
  stream: NodeJS.ReadableStream;
  mimeType: string;
  fileName: string;
  fileLength?: number;
}

export interface MediaByteRange {
  startByte?: number;
  endByte?: number;
}

export interface MediaGalleryItem {
  id: string;
  groupId: string;
  groupName: string;
  timestamp: number;
  text: string;
  type: StoredMedia["type"];
  mimeType: string;
  fileName?: string;
}

export class WhatsappMonitor {
  readonly stats = new StatsStore();

  private readonly messages: StoredMessage[] = [];
  private readonly groups = new Map<string, DiscoveredGroup>();
  private readonly groupMetadataCache = new Map<string, GroupMetadata>();
  private _sock: ReturnType<typeof makeWASocket> | null = null;
  private connectionState = "starting";
  private disconnectsTotal = new Map<string, number>();
  private reconnectsTotal = 0;
  private messagesReceivedTotal = new Map<string, number>();
  private messagesPersistedTotal = 0;
  private messagePersistFailuresTotal = 0;
  private lastMessageTimestampMs = 0;
  private lastPersistTimestampMs = 0;

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
        this.connectionState = connection;
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
        this.incrementDisconnect(statusCode, disconnectError?.message);

        if (statusCode !== DisconnectReason.loggedOut) {
          console.log("WhatsApp disconnected; reconnecting.");
          this.reconnectsTotal += 1;
          void this.connect();
        } else {
          console.log("WhatsApp session logged out. Remove data/auth to log in again.");
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      console.log(`Received WhatsApp message upsert: ${type} (${messages.length}).`);

      for (const message of messages) {
        await this.handleMessage(message, type);
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

  getMediaGallery(groupId: string, from: number, to: number): MediaGalleryItem[] {
    const items = new Map<string, MediaGalleryItem>();
    for (const message of this.messages) {
      if (
        message.groupId !== groupId
        || message.timestamp < from
        || message.timestamp > to
        || !message.media
        || !isGalleryMedia(message.media)
      ) {
        continue;
      }
      items.set(message.id, {
        id: message.id,
        groupId: message.groupId,
        groupName: message.groupName,
        timestamp: message.timestamp,
        text: message.text,
        type: message.media.type,
        mimeType: message.media.mimeType || defaultMimeType(message.media.type),
        fileName: message.media.fileName,
      });
    }
    return [...items.values()].sort((left, right) => left.timestamp - right.timestamp);
  }

  async downloadStoredMedia(
    groupId: string,
    messageId: string,
    range: MediaByteRange = {},
  ): Promise<MediaDownload | null> {
    const message = await this.findStoredMessage(groupId, messageId);
    const media = message?.media;
    if (!message || !media) {
      return null;
    }

    const stream = await downloadContentFromMessage(
      {
        mediaKey: Buffer.from(media.mediaKey, "base64"),
        directPath: media.directPath,
        url: media.url,
      },
      media.type as MediaType,
      range,
    );

    return {
      stream,
      mimeType: media.mimeType || defaultMimeType(media.type),
      fileName: media.fileName || `${message.id}.${defaultExtension(media.type, media.mimeType)}`,
      fileLength: media.fileLength,
    };
  }

  async sendTextMessage(jid: string, text: string): Promise<string | null> {
    if (!this._sock || this.connectionState !== "open") {
      throw new Error("WhatsApp connection is not open");
    }

    const result = await this._sock.sendMessage(jid, { text });
    return result?.key?.id ?? null;
  }

  getMetricSamples(): MetricSample[] {
    const nowSeconds = Date.now() / 1000;
    const lastMessageSeconds = this.lastMessageTimestampMs > 0
      ? this.lastMessageTimestampMs / 1000
      : 0;
    const lastPersistSeconds = this.lastPersistTimestampMs > 0
      ? this.lastPersistTimestampMs / 1000
      : 0;
    const samples: MetricSample[] = [
      {
        name: "whatsapp_monitor_up",
        help: "Whether the WhatsApp monitor process is serving metrics.",
        type: "gauge",
        value: 1,
      },
      {
        name: "whatsapp_connection_up",
        help: "Whether the WhatsApp socket connection is currently open.",
        type: "gauge",
        value: this.connectionState === "open" ? 1 : 0,
      },
      {
        name: "whatsapp_connection_state",
        help: "Current WhatsApp connection state as labelled gauges.",
        type: "gauge",
        value: 1,
        labels: { state: this.connectionState },
      },
      {
        name: "whatsapp_reconnects_total",
        help: "Total WhatsApp reconnect attempts made by the monitor.",
        type: "counter",
        value: this.reconnectsTotal,
      },
      {
        name: "whatsapp_messages_persisted_total",
        help: "Total WhatsApp messages persisted to disk.",
        type: "counter",
        value: this.messagesPersistedTotal,
      },
      {
        name: "whatsapp_message_persist_failures_total",
        help: "Total WhatsApp message persistence failures.",
        type: "counter",
        value: this.messagePersistFailuresTotal,
      },
      {
        name: "whatsapp_last_message_timestamp_seconds",
        help: "Unix timestamp of the latest captured WhatsApp message.",
        type: "gauge",
        value: lastMessageSeconds,
      },
      {
        name: "whatsapp_last_message_age_seconds",
        help: "Age in seconds of the latest captured WhatsApp message.",
        type: "gauge",
        value: lastMessageSeconds > 0 ? nowSeconds - lastMessageSeconds : 0,
      },
      {
        name: "whatsapp_last_persist_timestamp_seconds",
        help: "Unix timestamp of the latest persisted WhatsApp message.",
        type: "gauge",
        value: lastPersistSeconds,
      },
      {
        name: "whatsapp_groups_discovered",
        help: "Number of WhatsApp groups discovered from the active account.",
        type: "gauge",
        value: this.groups.size,
      },
      {
        name: "whatsapp_messages_buffered",
        help: "Number of recent messages currently held in memory.",
        type: "gauge",
        value: this.messages.length,
      },
    ];

    for (const [labels, count] of this.messagesReceivedTotal) {
      samples.push({
        name: "whatsapp_messages_received_total",
        help: "Total WhatsApp message upserts received by kind.",
        type: "counter",
        value: count,
        labels: JSON.parse(labels),
      });
    }

    for (const [labels, count] of this.disconnectsTotal) {
      samples.push({
        name: "whatsapp_disconnects_total",
        help: "Total WhatsApp disconnects by status code and reason.",
        type: "counter",
        value: count,
        labels: JSON.parse(labels),
      });
    }

    return samples;
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
      for (const m of tail) {
        this.stats.record(m);
        this.lastMessageTimestampMs = Math.max(this.lastMessageTimestampMs, m.timestamp);
      }
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
      this.messagesPersistedTotal += 1;
      this.lastPersistTimestampMs = Date.now();
    } catch (err) {
      this.messagePersistFailuresTotal += 1;
      console.error('Failed to append persisted message:', err);
    }
  }

  private async findStoredMessage(groupId: string, messageId: string): Promise<StoredMessage | null> {
    const buffered = [...this.messages].reverse().find((message) =>
      message.groupId === groupId && message.id === messageId
    );
    if (buffered) {
      return buffered;
    }

    const messagesPath = path.join(dataDir, 'messages.jsonl');
    try {
      const raw = await readFile(messagesPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const message = JSON.parse(lines[index]) as StoredMessage;
          if (message.groupId === groupId && message.id === messageId) {
            return message;
          }
        } catch {
          continue;
        }
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') console.warn('Failed to scan persisted messages for media:', e);
    }

    return null;
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

  private async handleMessage(message: WAMessage, upsertType?: string): Promise<void> {
    const remote = message.key.remoteJid;
    const media = extractMedia(message);
    const text = extractText(message) ?? mediaPlaceholder(media);

    // ignore messages without content or id
    if (!remote || !message.key.id) {
      this.incrementMessagesReceived("ignored:missing_key");
      console.log("Ignoring WhatsApp message without remote JID or message ID.");
      return;
    }
    if (!text) {
      const contentType = getContentType(normalizeMessageContent(message.message)) ?? "unknown";
      this.incrementMessagesReceived(`ignored:${contentType}`);
      console.log(`Ignoring WhatsApp message; no extractable text. ${ignoredMessageDetails(message, contentType, upsertType)}`);
      return;
    }
    if (isStatusBroadcast(remote)) {
      this.incrementMessagesReceived("status");
      console.log(`Ignoring WhatsApp status message. ${ignoredMessageDetails(message, "status", upsertType)}`);
      return;
    }
    if (message.key.fromMe) {
      this.incrementMessagesReceived("ignored:from_me");
      console.log(`Ignoring outgoing WhatsApp message. ${ignoredMessageDetails(message, "from_me", upsertType)}`);
      return;
    }

    const isGroup = typeof remote === 'string' && remote.endsWith('@g.us');
    this.incrementMessagesReceived(isGroup ? "group" : "dm");

    const config = await loadConfig();
    if (isGroup && config.monitoredGroups.length > 0 && !config.monitoredGroups.includes(remote)) {
      // monitoredGroups only applies to groups; DMs are always collected
      return;
    }

    const senderName = extractSenderName(message);
    const groupName = isGroup
      ? await this.getGroupName(remote)
      : `DM:${senderName ?? message.key.participant ?? remote}`;

    const timestamp = timestampToMs(message.messageTimestamp);
    const storedMessage: StoredMessage = {
      id: message.key.id,
      text,
      timestamp,
      sender: message.key.participant ?? (isGroup ? 'unknown' : remote),
      senderName,
      groupId: remote,
      groupName,
      media,
    };

    console.log(`Incoming ${isGroup ? 'group' : 'DM'} message [${groupName}]: ${text}`);

    // Append to in-memory store
    this.messages.push(storedMessage);
    this.stats.record(storedMessage);
    this.lastMessageTimestampMs = Math.max(this.lastMessageTimestampMs, timestamp);

    // Persist to disk as JSONL
    try {
      await this.appendPersistedMessage(storedMessage);
      console.log(`Persisted message ${storedMessage.id}`);
    } catch (e) {
      console.error('Failed to persist message:', e);
    }

    console.log(`Stored message ${storedMessage.id} from ${storedMessage.sender}.`);
  }

  private incrementMessagesReceived(kind: string): void {
    const labels = JSON.stringify({ kind });
    this.messagesReceivedTotal.set(labels, (this.messagesReceivedTotal.get(labels) ?? 0) + 1);
  }

  private async getGroupName(groupId: string): Promise<string> {
    const cachedName = this.groupMetadataCache.get(groupId)?.subject ?? this.groups.get(groupId)?.name;
    if (cachedName) {
      return cachedName;
    }

    try {
      const metadata = await this._sock?.groupMetadata(groupId);
      if (metadata) {
        this.groupMetadataCache.set(groupId, metadata);
        const group = { id: metadata.id, name: metadata.subject };
        this.groups.set(group.id, group);
        await saveGroups([...this.groups.values()]);
        console.log("Discovered group from incoming message:", group);
        return metadata.subject;
      }
    } catch (error) {
      console.warn(`Could not fetch metadata for incoming group ${groupId}.`, error);
    }

    return groupId;
  }

  private incrementDisconnect(statusCode: number | undefined, reason: string | undefined): void {
    const labels = JSON.stringify({
      status_code: statusCode ?? "unknown",
      reason: reason ?? "unknown",
    });
    this.disconnectsTotal.set(labels, (this.disconnectsTotal.get(labels) ?? 0) + 1);
  }
}

function isStatusBroadcast(remoteJid: string): boolean {
  return remoteJid === 'status@broadcast';
}

function extractText(message: WAMessage): string | undefined {
  const content = normalizeMessageContent(message.message);
  const contentType = getContentType(content);
  const templateText = extractTemplateText(content);
  const interactiveText = extractInteractiveText(content);
  const hsmText = extractHighlyStructuredText(content?.highlyStructuredMessage);
  const genericText = shouldUseGenericFallback(contentType)
    ? extractGenericMessageText(content)
    : undefined;

  return (
    content?.conversation ??
    content?.extendedTextMessage?.text ??
    content?.imageMessage?.caption ??
    content?.videoMessage?.caption ??
    content?.documentMessage?.caption ??
    content?.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    content?.buttonsResponseMessage?.selectedDisplayText ??
    content?.listResponseMessage?.title ??
    content?.templateButtonReplyMessage?.selectedDisplayText ??
    content?.pollCreationMessage?.name ??
    content?.pollCreationMessageV2?.name ??
    content?.pollCreationMessageV3?.name ??
    content?.listMessage?.description ??
    content?.listMessage?.title ??
    content?.listMessage?.footerText ??
    content?.buttonsMessage?.contentText ??
    content?.productMessage?.product?.title ??
    content?.productMessage?.product?.description ??
    interactiveText ??
    templateText ??
    hsmText ??
    genericText ??
    undefined
  )?.trim();
}

function extractMedia(message: WAMessage): StoredMedia | undefined {
  const content = normalizeMessageContent(message.message);
  const mediaCandidates: Array<[StoredMedia["type"], AnyRecord | undefined]> = [
    ["image", asRecord(content?.imageMessage)],
    ["video", asRecord(content?.videoMessage)],
    ["document", asRecord(content?.documentMessage)],
    ["document", asRecord(content?.documentWithCaptionMessage?.message?.documentMessage)],
    ["audio", asRecord(content?.audioMessage)],
    ["sticker", asRecord(content?.stickerMessage)],
  ];

  for (const [type, media] of mediaCandidates) {
    if (!media) {
      continue;
    }

    const mediaKey = bytesToBase64(media.mediaKey);
    const directPath = textValue(media.directPath);
    const url = textValue(media.url);
    if (!mediaKey || (!directPath && !url)) {
      continue;
    }

    return {
      type,
      mediaKey,
      directPath,
      url,
      mimeType: textValue(media.mimetype),
      fileName: textValue(media.fileName),
      fileLength: numberValue(media.fileLength),
    };
  }

  return undefined;
}

function bytesToBase64(value: unknown): string | undefined {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (typeof value === "string" && value.trim()) {
    return Buffer.from(value, "base64").toString("base64");
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "object" && value !== null && "toNumber" in value && typeof value.toNumber === "function") {
    return value.toNumber();
  }
  return undefined;
}

function defaultMimeType(type: StoredMedia["type"]): string {
  switch (type) {
    case "image":
      return "image/jpeg";
    case "video":
      return "video/mp4";
    case "audio":
      return "audio/ogg";
    case "sticker":
      return "image/webp";
    case "document":
    default:
      return "application/octet-stream";
  }
}

function isGalleryMedia(media: StoredMedia): boolean {
  return ["image", "video", "sticker"].includes(media.type)
    || (media.type === "document" && media.mimeType?.toLowerCase() === "application/pdf");
}

function mediaPlaceholder(media: StoredMedia | undefined): string | undefined {
  if (!media) return undefined;
  if (media.type === "image") return "Shared a photo";
  if (media.type === "video") return "Shared a video";
  if (media.type === "sticker") return "Shared a sticker";
  if (media.type === "audio") return "Shared an audio message";
  return media.fileName ? `Shared document: ${media.fileName}` : "Shared a document";
}

function defaultExtension(type: StoredMedia["type"], mimeType: string | undefined): string {
  const lowerMime = mimeType?.toLowerCase();
  if (lowerMime?.includes("png")) return "png";
  if (lowerMime?.includes("webp")) return "webp";
  if (lowerMime?.includes("gif")) return "gif";
  if (lowerMime?.includes("mp4")) return "mp4";
  if (lowerMime?.includes("pdf")) return "pdf";
  if (lowerMime?.includes("mpeg")) return "mp3";

  switch (type) {
    case "image":
      return "jpg";
    case "video":
      return "mp4";
    case "audio":
      return "ogg";
    case "sticker":
      return "webp";
    case "document":
    default:
      return "bin";
  }
}

function ignoredMessageDetails(message: WAMessage, contentType: string, upsertType?: string): string {
  const content = normalizeMessageContent(message.message);
  const timestamp = timestampToMs(message.messageTimestamp);
  const envelope = message as AnyRecord;
  const summary = {
    id: message.key.id,
    remoteJid: message.key.remoteJid,
    participant: message.key.participant,
    fromMe: message.key.fromMe,
    upsertType,
    timestamp,
    timestampIso: new Date(timestamp).toISOString(),
    pushName: envelope.pushName,
    broadcast: envelope.broadcast,
    messageStubType: envelope.messageStubType,
    messageStubParameters: envelope.messageStubParameters,
    contentType,
    rawMessageKeys: objectKeys(message.message),
    messageKeys: objectKeys(content),
    envelopeKeys: objectKeys(envelope),
    contentSummary: summarizeMessageObject(content),
  };

  return JSON.stringify(summary);
}

function extractSenderName(message: WAMessage): string | undefined {
  const envelope = message as AnyRecord;
  const name = textValue(envelope.pushName)?.trim();
  if (!name || looksLikeWhatsAppJid(name)) {
    return undefined;
  }
  return name;
}

function looksLikeWhatsAppJid(value: string): boolean {
  return /@(?:s\.whatsapp\.net|lid|g\.us|newsletter)\b/.test(value);
}

function extractTemplateText(content: AnyRecord | undefined): string | undefined {
  const template = content?.templateMessage;
  if (!isRecord(template)) {
    return undefined;
  }

  const hydrated = firstRecord(template.hydratedTemplate, template.hydratedFourRowTemplate);
  const fourRow = asRecord(template.fourRowTemplate);
  const parts = [
    textValue(template.templateId),
    extractKnownText(hydrated, [
      "hydratedTitleText",
      "hydratedContentText",
      "hydratedFooterText",
      "templateId",
    ]),
    extractKnownText(fourRow, []),
    extractHighlyStructuredText(fourRow?.content),
    extractHighlyStructuredText(fourRow?.footer),
    extractHighlyStructuredText(fourRow?.highlyStructuredMessage),
    extractInteractiveText({ interactiveMessage: template.interactiveMessageTemplate }),
  ];

  return joinTextParts(parts);
}

function extractInteractiveText(content: AnyRecord | undefined): string | undefined {
  const interactive = asRecord(content?.interactiveMessage);
  const response = asRecord(content?.interactiveResponseMessage);
  const nativeFlow = asRecord(interactive?.nativeFlowMessage);
  const responseFlow = asRecord(response?.nativeFlowResponseMessage);

  const parts = [
    textValue(asRecord(interactive?.header)?.title),
    textValue(asRecord(interactive?.body)?.text),
    textValue(asRecord(interactive?.footer)?.text),
    textValue(asRecord(response?.body)?.text),
    extractKnownText(nativeFlow, ["messageParamsJson"]),
    extractKnownText(responseFlow, ["name", "paramsJson"]),
  ];

  return joinTextParts(parts);
}

function extractHighlyStructuredText(value: unknown): string | undefined {
  const hsm = asRecord(value);
  if (!hsm) {
    return undefined;
  }

  const params = Array.isArray(hsm.params) ? hsm.params.map(textValue) : [];
  const localizableParams = Array.isArray(hsm.localizableParams)
    ? hsm.localizableParams.map((param) =>
        extractKnownText(asRecord(param), ["default", "currencyCode", "dateTimeValue"]),
      )
    : [];

  return joinTextParts([
    textValue(hsm.namespace),
    textValue(hsm.elementName),
    textValue(hsm.fallbackLg),
    textValue(hsm.fallbackLc),
    textValue(hsm.deterministicLg),
    textValue(hsm.deterministicLc),
    ...params,
    ...localizableParams,
    extractTemplateText({ templateMessage: hsm.hydratedHsm }),
  ]);
}

function extractGenericMessageText(content: unknown): string | undefined {
  const textFields = collectStringFields(content, 0)
    .filter(({ key, value }) => isUsefulExtractedText(key, value))
    .map(({ key, value }) => `${key}: ${value}`);

  return joinTextParts(textFields.slice(0, 12));
}

function shouldUseGenericFallback(contentType: string | undefined): boolean {
  return Boolean(
    contentType &&
      [
        "templateMessage",
        "interactiveMessage",
        "interactiveResponseMessage",
        "highlyStructuredMessage",
        "buttonsMessage",
        "listMessage",
        "productMessage",
        "orderMessage",
      ].includes(contentType),
  );
}

function collectStringFields(value: unknown, depth: number): Array<{ key: string; value: string }> {
  if (depth > 5 || value == null || typeof value !== "object") {
    return [];
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return [];
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const fields: Array<{ key: string; value: string }> = [];

  for (const [key, child] of entries) {
    if (typeof child === "string") {
      fields.push({ key, value: child });
      continue;
    }

    if (Array.isArray(child)) {
      for (const item of child.slice(0, 8)) {
        fields.push(...collectStringFields(item, depth + 1));
      }
      continue;
    }

    fields.push(...collectStringFields(child, depth + 1));
  }

  return fields;
}

function summarizeMessageObject(value: unknown): unknown {
  if (value == null || typeof value !== "object") {
    return value;
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[bytes:${value.byteLength}]`;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 5).map(summarizeMessageObject);
  }

  const summary: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    if (typeof child === "string") {
      summary[key] = limitForLog(child, 240);
    } else if (typeof child === "number" || typeof child === "boolean" || child == null) {
      summary[key] = child;
    } else if (Buffer.isBuffer(child) || child instanceof Uint8Array) {
      summary[key] = `[bytes:${child.byteLength}]`;
    } else if (Array.isArray(child)) {
      summary[key] = child.slice(0, 5).map(summarizeMessageObject);
    } else {
      summary[key] = {
        keys: objectKeys(child),
        textFields: collectStringFields(child, 0)
          .filter(({ key: textKey, value: textValue }) => isUsefulExtractedText(textKey, textValue))
          .slice(0, 8)
          .map(({ key: textKey, value: textValue }) => `${textKey}:${limitForLog(textValue, 120)}`),
      };
    }
  }

  return summary;
}

function extractKnownText(record: AnyRecord | undefined, keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }

  const parts = keys.map((key) => textValue(record[key]));
  return joinTextParts([...parts, extractHighlyStructuredText(record.highlyStructuredMessage)]);
}

function joinTextParts(parts: Array<string | undefined>): string | undefined {
  const seen = new Set<string>();
  const normalized = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .filter((part) => {
      if (seen.has(part)) {
        return false;
      }
      seen.add(part);
      return true;
    });

  return normalized.length > 0 ? normalized.join("\n") : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isUsefulExtractedText(key: string, value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return false;
  }
  if (trimmed.length > 2000) {
    return false;
  }

  const loweredKey = key.toLowerCase();
  if (["mimetype", "filehash", "jpegthumbnail", "thumbnaildirectpath", "directpath"].includes(loweredKey)) {
    return false;
  }

  return true;
}

function firstRecord(...values: unknown[]): AnyRecord | undefined {
  return values.map(asRecord).find(Boolean);
}

function asRecord(value: unknown): AnyRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is AnyRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function objectKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

function limitForLog(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

type AnyRecord = Record<string, any>;

function timestampToMs(timestamp: WAMessage["messageTimestamp"]): number {
  if (typeof timestamp === "number") {
    return timestamp * 1000;
  }

  if (typeof timestamp === "object" && timestamp !== null) {
    return timestamp.toNumber() * 1000;
  }

  return Date.now();
}
