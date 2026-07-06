import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WhatsappMonitor, MediaGalleryItem } from "./whatsapp.js";
import { dataDir } from "./config.js";
import type { MetricSample } from "./metrics.js";

const execFileAsync = promisify(execFile);
const DURATION_METRIC = "whatsapp_image_analysis_duration_seconds";
const DURATION_BUCKETS_SECONDS = [0.5, 1, 2, 3, 5, 10, 20, 30, 60];

export interface ImageAnalysisRecord {
  media_id: string;
  group_id: string;
  status: "pending" | "processing" | "success" | "error";
  error_message?: string | null;
  width?: number;
  height?: number;
  file_size_bytes?: number;
  brightness_mean?: number;
  brightness_label?: string;
  contrast_stddev?: number;
  contrast_label?: string;
  blur_score?: number;
  blur_label?: string;
  edge_density?: number;
  noise_score?: number;
  dominant_colors?: Array<{ rgb: number[]; percent: number }>;
  similar_matches?: Array<{ group_id: string; media_id: string; distance: number; duplicate: boolean }>;
  exact_duplicate_of?: string | null;
  compression_label?: string;
  low_frequency_energy?: number;
  medium_frequency_energy?: number;
  high_frequency_energy?: number;
  is_screenshot?: boolean;
  preview_grayscale_path?: string;
  preview_edges_path?: string;
  preview_fourier_path?: string;
  preview_histogram_path?: string;
}

interface QueueItem {
  groupId: string;
  mediaId: string;
  mimeType: string;
  force: boolean;
}

export class ImageAnalysisService {
  private readonly queue: QueueItem[] = [];
  private readonly queuedKeys = new Set<string>();
  private running = 0;
  private readonly concurrency: number;
  private readonly cacheDir = path.join(dataDir, "image-analysis", "cache");
  private readonly previewDir = path.join(dataDir, "image-analysis", "previews");
  private readonly dbPath = path.join(dataDir, "image_analysis.db");
  private enqueuedTotal = 0;
  private skippedExistingTotal = 0;
  private successesTotal = 0;
  private failuresTotal = 0;
  private processingDurationSecondsSum = 0;
  private processingDurationSecondsCount = 0;
  private readonly processingDurationBucketCounts = DURATION_BUCKETS_SECONDS.map(() => 0);
  private lastProcessingDurationSeconds = 0;
  private lastRunTimestampSeconds = 0;
  private lastSuccessTimestampSeconds = 0;
  private lastFailureTimestampSeconds = 0;

  constructor(private readonly monitor: WhatsappMonitor) {
    this.concurrency = Math.max(1, Math.min(2, Number(process.env.IMAGE_ANALYSIS_CONCURRENCY || "1") || 1));
  }

  async records(groupId?: string, mediaId?: string): Promise<ImageAnalysisRecord[]> {
    const args = ["scripts/analyse_images.py", "--query", "--db", this.dbPath];
    if (groupId) args.push("--group-id", groupId);
    if (mediaId) args.push("--media-id", mediaId);
    try {
      const { stdout } = await execFileAsync(pythonCommand(), args, { maxBuffer: 8 * 1024 * 1024 });
      return JSON.parse(stdout || "[]") as ImageAnalysisRecord[];
    } catch (error: any) {
      if (error.code === "ENOENT") {
        console.warn("Python is not available for image analysis queries.");
        return [];
      }
      console.warn("Could not load image analysis records:", error.message);
      return [];
    }
  }

  async recordsByMediaId(groupId: string): Promise<Map<string, ImageAnalysisRecord>> {
    const rows = await this.records(groupId);
    return new Map(rows.map((row) => [row.media_id, row]));
  }

  enqueueGallery(items: MediaGalleryItem[], force = false): number {
    return this.enqueue(items.filter((item) => item.type === "image" || item.type === "sticker"), force);
  }

  enqueueTargets(groupId?: string, mediaId?: string, force = false): number {
    return this.enqueue(this.monitor.getImageAnalysisTargets(groupId, mediaId), force);
  }

  stats(): { queued: number; running: number; concurrency: number } {
    return { queued: this.queue.length, running: this.running, concurrency: this.concurrency };
  }

  async getMetricSamples(): Promise<MetricSample[]> {
    const samples: MetricSample[] = [
      {
        name: "whatsapp_image_analysis_queue_depth",
        help: "Number of image analysis jobs waiting in the in-process queue.",
        type: "gauge",
        value: this.queue.length,
      },
      {
        name: "whatsapp_image_analysis_running",
        help: "Number of image analysis jobs currently running.",
        type: "gauge",
        value: this.running,
      },
      {
        name: "whatsapp_image_analysis_concurrency",
        help: "Configured maximum concurrent image analysis jobs.",
        type: "gauge",
        value: this.concurrency,
      },
      {
        name: "whatsapp_image_analysis_enqueued_total",
        help: "Total image analysis jobs enqueued since service start.",
        type: "counter",
        value: this.enqueuedTotal,
      },
      {
        name: "whatsapp_image_analysis_skipped_existing_total",
        help: "Total queued image analysis jobs skipped because a result already existed.",
        type: "counter",
        value: this.skippedExistingTotal,
      },
      {
        name: "whatsapp_image_analysis_runs_total",
        help: "Total image analysis processing attempts by result status since service start.",
        type: "counter",
        value: this.successesTotal,
        labels: { status: "success" },
      },
      {
        name: "whatsapp_image_analysis_runs_total",
        help: "Total image analysis processing attempts by result status since service start.",
        type: "counter",
        value: this.failuresTotal,
        labels: { status: "error" },
      },
      ...DURATION_BUCKETS_SECONDS.map((bucketSeconds, index) => ({
        name: `${DURATION_METRIC}_bucket`,
        familyName: DURATION_METRIC,
        help: "Wall-clock image analysis processing duration in seconds.",
        type: "histogram" as const,
        value: this.processingDurationBucketCounts[index],
        labels: { le: bucketSeconds },
      })),
      {
        name: `${DURATION_METRIC}_bucket`,
        familyName: DURATION_METRIC,
        help: "Wall-clock image analysis processing duration in seconds.",
        type: "histogram",
        value: this.processingDurationSecondsCount,
        labels: { le: "+Inf" },
      },
      {
        name: "whatsapp_image_analysis_duration_seconds_sum",
        familyName: DURATION_METRIC,
        help: "Wall-clock image analysis processing duration in seconds.",
        type: "histogram",
        value: this.processingDurationSecondsSum,
      },
      {
        name: "whatsapp_image_analysis_duration_seconds_count",
        familyName: DURATION_METRIC,
        help: "Wall-clock image analysis processing duration in seconds.",
        type: "histogram",
        value: this.processingDurationSecondsCount,
      },
      {
        name: "whatsapp_image_analysis_last_duration_seconds",
        help: "Wall-clock duration of the latest image analysis processing attempt in seconds.",
        type: "gauge",
        value: this.lastProcessingDurationSeconds,
      },
      {
        name: "whatsapp_image_analysis_last_run_timestamp_seconds",
        help: "Unix timestamp of the latest image analysis processing attempt.",
        type: "gauge",
        value: this.lastRunTimestampSeconds,
      },
      {
        name: "whatsapp_image_analysis_last_success_timestamp_seconds",
        help: "Unix timestamp of the latest successful image analysis processing attempt.",
        type: "gauge",
        value: this.lastSuccessTimestampSeconds,
      },
      {
        name: "whatsapp_image_analysis_last_failure_timestamp_seconds",
        help: "Unix timestamp of the latest failed image analysis processing attempt.",
        type: "gauge",
        value: this.lastFailureTimestampSeconds,
      },
    ];

    const records = await this.records();
    const statusCounts = new Map<string, number>();
    let blurry = 0;
    let dark = 0;
    let duplicates = 0;
    let compressed = 0;
    let screenshots = 0;
    for (const record of records) {
      statusCounts.set(record.status, (statusCounts.get(record.status) ?? 0) + 1);
      if (record.blur_label === "blurry" || record.blur_label === "slightly blurry") blurry += 1;
      if (record.brightness_label === "dark" || record.brightness_label === "very dark") dark += 1;
      if (record.exact_duplicate_of || record.similar_matches?.some((match) => match.duplicate)) duplicates += 1;
      if (record.compression_label === "heavily compressed") compressed += 1;
      if (record.is_screenshot) screenshots += 1;
    }

    for (const status of ["success", "error", "processing", "pending"]) {
      samples.push({
        name: "whatsapp_image_analysis_records",
        help: "Persisted image analysis records by status.",
        type: "gauge",
        value: statusCounts.get(status) ?? 0,
        labels: { status },
      });
    }
    for (const [signal, count] of Object.entries({ blurry, dark, duplicates, compressed, screenshots })) {
      samples.push({
        name: "whatsapp_image_analysis_signal_records",
        help: "Persisted successful image analysis records matching selected gallery signals.",
        type: "gauge",
        value: count,
        labels: { signal },
      });
    }
    return samples;
  }

  async previewPath(groupId: string, mediaId: string, kind: string): Promise<string | null> {
    const record = (await this.records(groupId, mediaId))[0];
    const field = ({
      grayscale: "preview_grayscale_path",
      edges: "preview_edges_path",
      fourier: "preview_fourier_path",
      histogram: "preview_histogram_path",
    } as const)[kind as "grayscale" | "edges" | "fourier" | "histogram"];
    if (!field) return null;
    const value = record?.[field];
    if (typeof value !== "string" || !value) return null;
    const resolved = path.resolve(value);
    const previewRoot = path.resolve(this.previewDir);
    if (!resolved.startsWith(`${previewRoot}${path.sep}`)) return null;
    try {
      await readFile(resolved);
      return resolved;
    } catch {
      return null;
    }
  }

  private enqueue(items: MediaGalleryItem[], force: boolean): number {
    let queued = 0;
    for (const item of items) {
      const key = `${item.groupId}:${item.id}`;
      if (this.queuedKeys.has(key)) continue;
      this.queuedKeys.add(key);
      this.queue.push({ groupId: item.groupId, mediaId: item.id, mimeType: item.mimeType, force });
      queued += 1;
      this.enqueuedTotal += 1;
    }
    void this.pump();
    return queued;
  }

  private async pump(): Promise<void> {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.running += 1;
      void this.process(item)
        .catch((error) => console.warn(`Image analysis failed for ${item.groupId}/${item.mediaId}:`, error.message))
        .finally(() => {
          this.running -= 1;
          this.queuedKeys.delete(`${item.groupId}:${item.mediaId}`);
          void this.pump();
        });
    }
  }

  private async process(item: QueueItem): Promise<void> {
    const startedAt = process.hrtime.bigint();
    let recordedDuration = false;
    if (!item.force) {
      const existing = (await this.records(item.groupId, item.mediaId))[0];
      if (existing && ["success", "error", "processing"].includes(existing.status)) {
        this.skippedExistingTotal += 1;
        return;
      }
    }
    this.lastRunTimestampSeconds = Date.now() / 1000;
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const tempPath = path.join(this.cacheDir, `${safeName(item.groupId)}_${safeName(item.mediaId)}.${extensionFor(item.mimeType)}`);
      const media = await this.monitor.downloadStoredMedia(item.groupId, item.mediaId);
      if (!media) throw new Error("media not found");
      await pipeline(media.stream, createWriteStream(tempPath));

      const args = [
        "scripts/analyse_images.py",
        "--file", tempPath,
        "--group-id", item.groupId,
        "--media-id", item.mediaId,
        "--db", this.dbPath,
        "--json",
      ];
      if (item.force) args.push("--force");
      try {
        await execFileAsync(pythonCommand(), args, {
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, IMAGE_ANALYSIS_PREVIEW_DIR: this.previewDir, IMAGE_ANALYSIS_DB: this.dbPath },
        });
        this.successesTotal += 1;
        this.lastSuccessTimestampSeconds = Date.now() / 1000;
      } finally {
        await rm(tempPath, { force: true });
      }
    } catch (error) {
      this.failuresTotal += 1;
      this.lastFailureTimestampSeconds = Date.now() / 1000;
      throw error;
    } finally {
      const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      if (!recordedDuration) {
        this.processingDurationSecondsSum += elapsedSeconds;
        this.processingDurationSecondsCount += 1;
        for (const [index, bucketSeconds] of DURATION_BUCKETS_SECONDS.entries()) {
          if (elapsedSeconds <= bucketSeconds) this.processingDurationBucketCounts[index] += 1;
        }
        this.lastProcessingDurationSeconds = elapsedSeconds;
        recordedDuration = true;
      }
    }
  }
}

function pythonCommand(): string {
  if (process.env.IMAGE_ANALYSIS_PYTHON) return process.env.IMAGE_ANALYSIS_PYTHON;
  const venvPython = path.join(process.cwd(), ".venv", "bin", "python");
  return existsSync(venvPython) ? venvPython : "python3";
}

function extensionFor(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  return "jpg";
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 120);
}
