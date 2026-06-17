import express from "express";
import type { WhatsappMonitor } from "./whatsapp.js";
import { HttpMetrics, renderPrometheus } from "./metrics.js";

export function startServer(monitor: WhatsappMonitor, port: number): void {
  const app = express();
  const httpMetrics = new HttpMetrics();
  const sendMessageToken = process.env.WHATSAPP_SEND_TOKEN?.trim();

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

  app.get("/metrics", (_request, response) => {
    response
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(renderPrometheus([
        ...monitor.getMetricSamples(),
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
