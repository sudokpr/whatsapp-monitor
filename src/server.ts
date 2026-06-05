import express from "express";
import type { WhatsappMonitor } from "./whatsapp.js";

export function startServer(monitor: WhatsappMonitor, port: number): void {
  const app = express();

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