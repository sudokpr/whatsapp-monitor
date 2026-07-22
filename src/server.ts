import express from "express";
import type { WhatsappMonitor } from "./whatsapp.js";
import { HttpMetrics, renderPrometheus } from "./metrics.js";
import { renderGallery } from "./gallery.js";
import { ImageAnalysisService } from "./imageAnalysis.js";

export function startServer(monitor: WhatsappMonitor, port: number): void {
  const app = express();
  const httpMetrics = new HttpMetrics();
  const imageAnalysis = new ImageAnalysisService(monitor);
  const sendMessageToken = process.env.WHATSAPP_SEND_TOKEN?.trim();
  const mediaToken = process.env.WHATSAPP_MEDIA_TOKEN?.trim();

  app.use(express.json({ limit: "1mb" }));

  app.use((request, response, next) => {
    const startedAt = process.hrtime.bigint();
    response.on("finish", () => {
      const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      httpMetrics.record(
        request.method,
        request.route?.path?.toString() ?? request.path,
        response.statusCode,
        elapsedSeconds,
      );
    });
    next();
  });

  app.get("/health", (_request, response) => {
    response.type("text/plain").send("ok");
  });

  app.get("/groups", (_request, response) => {
    response.json(monitor.getGroups());
  });

  app.get("/listings", (_request, response) => {
    response.json(monitor.getListings(100));
  });

  app.get("/gallery", async (request, response) => {
    if (mediaToken && request.query.token !== mediaToken) {
      response.status(401).send("Unauthorized");
      return;
    }

    const groupId = typeof request.query.groupId === "string" ? request.query.groupId : "";
    const from = Number(request.query.from);
    const to = Number(request.query.to);
    if (!groupId || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) {
      response.status(400).send("Invalid gallery parameters");
      return;
    }

    const items = monitor.getMediaGallery(groupId, from, to);
    const analysisByMediaId = await imageAnalysis.recordsByMediaId(groupId);
    for (const item of items) {
      item.analysis = analysisByMediaId.get(item.id);
    }
    imageAnalysis.enqueueGallery(items);
    response.type("html").send(renderGallery(items, mediaToken));
  });

  app.get("/api/image-analysis", async (request, response) => {
    if (!authorizeMediaRequest(request, mediaToken)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    const groupId = typeof request.query.groupId === "string" ? request.query.groupId : undefined;
    const mediaId = typeof request.query.mediaId === "string" ? request.query.mediaId : undefined;
    response.json({
      records: await imageAnalysis.records(groupId, mediaId),
      queue: imageAnalysis.stats(),
    });
  });

  app.post("/api/image-analysis/run", (request, response) => {
    if (!authorizeMediaRequest(request, mediaToken)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    const body = request.body as Partial<{ groupId: string; mediaId: string; force: boolean }>;
    const groupId = typeof body.groupId === "string" && body.groupId ? body.groupId : undefined;
    const mediaId = typeof body.mediaId === "string" && body.mediaId ? body.mediaId : undefined;
    if (!groupId && !mediaId) {
      response.status(400).json({ error: "Set groupId or mediaId" });
      return;
    }
    const queued = imageAnalysis.enqueueTargets(groupId, mediaId, Boolean(body.force));
    response.json({ ok: true, queued, queue: imageAnalysis.stats() });
  });

  app.get("/api/image-analysis/:groupId/:messageId/preview/:kind", async (request, response) => {
    if (!authorizeMediaRequest(request, mediaToken)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    const previewPath = await imageAnalysis.previewPath(
      request.params.groupId,
      request.params.messageId,
      request.params.kind,
    );
    if (!previewPath) {
      response.status(404).json({ error: "Preview not found" });
      return;
    }
    response.type("png").sendFile(previewPath);
  });

  app.get("/media/:groupId/:messageId", async (request, response) => {
    if (!authorizeMediaRequest(request, mediaToken)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      const requestedRange = parseByteRange(request.header("range"));
      if (requestedRange === "invalid") {
        response.status(416).end();
        return;
      }

      const media = await monitor.downloadStoredMedia(
        request.params.groupId,
        request.params.messageId,
        requestedRange
          ? { startByte: requestedRange.start, endByte: requestedRange.end === undefined ? undefined : requestedRange.end + 1 }
          : undefined,
      );
      if (!media) {
        response.status(404).json({ error: "Media not found" });
        return;
      }

      if (requestedRange && media.fileLength !== undefined) {
        const end = Math.min(requestedRange.end ?? media.fileLength - 1, media.fileLength - 1);
        if (requestedRange.start >= media.fileLength || end < requestedRange.start) {
          response.setHeader("Content-Range", `bytes */${media.fileLength}`);
          response.status(416).end();
          return;
        }
        response.status(206);
        response.setHeader("Content-Range", `bytes ${requestedRange.start}-${end}/${media.fileLength}`);
        response.setHeader("Content-Length", end - requestedRange.start + 1);
      } else if (media.fileLength !== undefined) {
        response.setHeader("Content-Length", media.fileLength);
      }

      response.setHeader("Content-Type", media.mimeType);
      response.setHeader("Content-Disposition", `inline; filename="${safeHeaderFilename(media.fileName)}"`);
      response.setHeader("Accept-Ranges", media.fileLength !== undefined ? "bytes" : "none");
      media.stream.on("error", (error) => {
        console.warn("Media download stream failed:", error);
        if (!response.headersSent) {
          response.status(502).json({ error: "Media download failed" });
        } else {
          response.end();
        }
      });
      media.stream.pipe(response);
    } catch (error: any) {
      response.status(502).json({ error: error.message });
    }
  });

  app.get("/stats", (_request, response) => {
    response.json({
      messagesPerDay: monitor.stats.messagesPerDay,
      topUsers: monitor.stats.getTopUsers(10),
      topGroups: monitor.stats.getTopGroups(10),
    });
  });

  app.get("/participants", (_request, response) => {
    response.json(monitor.getAllParticipants());
  });

  app.post("/send-message", async (request, response) => {
    if (sendMessageToken) {
      const token = request.header("x-api-key") ?? request.header("authorization")?.replace(/^Bearer\s+/i, "");
      if (token !== sendMessageToken) {
        response.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    const body = request.body as Partial<{ jid: string; text: string }>;
    const jid = typeof body.jid === "string" ? body.jid.trim() : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";

    if (!jid || !text) {
      response.status(400).json({ error: "Set jid and text" });
      return;
    }

    try {
      const id = await monitor.sendTextMessage(jid, text);
      response.json({ ok: true, id });
    } catch (error: any) {
      response.status(503).json({ error: error.message });
    }
  });

  app.get("/metrics", async (_request, response) => {
    response
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(renderPrometheus([
        ...monitor.getMetricSamples(),
        ...await imageAnalysis.getMetricSamples(),
        ...httpMetrics.samples(),
      ]));
  });

  app.get("/group/:id/metadata", async (req, res) => {
    try {
      const metadata = await monitor.getGroupMetadataWithParticipants(req.params.id);
      if (!metadata) { res.status(404).json({ error: "Not found" }); return; }
      res.json(metadata);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.listen(port, () => {
    console.log(`HTTP API listening on http://localhost:${port}`);
  });
}

function authorizeMediaRequest(request: express.Request, mediaToken: string | undefined): boolean {
  if (!mediaToken) return true;
  const token = request.query.token ?? request.header("x-api-key");
  return token === mediaToken;
}

function safeHeaderFilename(fileName: string): string {
  return fileName.replace(/[\\"]/g, "_").replace(/[\r\n]/g, "");
}

function parseByteRange(value: string | undefined): { start: number; end?: number } | "invalid" | null {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim());
  if (!match) return "invalid";

  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  if (!Number.isSafeInteger(start) || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) {
    return "invalid";
  }
  return { start, end };
}
