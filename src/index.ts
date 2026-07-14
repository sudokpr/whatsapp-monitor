import { ensureDataFiles } from "./config.js";
import { loadLocalEnv } from "./env.js";
import { startServer } from "./server.js";
import { WhatsappMonitor } from "./whatsapp.js";

await loadLocalEnv();

const port = Number(process.env.PORT ?? 3000);
const monitor = new WhatsappMonitor();

await ensureDataFiles();
startServer(monitor, port);
await monitor.connect();
