import { ensureDataFiles } from "./config.js";
import { startServer } from "./server.js";
import { WhatsappMonitor } from "./whatsapp.js";

const port = Number(process.env.PORT ?? 3000);
const monitor = new WhatsappMonitor();

await ensureDataFiles();
startServer(monitor, port);
await monitor.connect();
