import express from "express";
import { config } from "./config";
import { webhookRouter } from "./webhook";
import { startScheduler } from "./scheduler";
import { closeDb } from "./memory/db";

// Import tools to trigger registration
import "./tools";

const app = express();

// Log every incoming request before anything else
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url} | Content-Type: ${req.headers["content-type"]} | Content-Length: ${req.headers["content-length"]}`);
  next();
});

// Parse JSON bodies -- also accept requests without Content-Type header
app.use(express.json({ limit: "10mb", type: ["application/json", "text/*"] }));

// Catch JSON parse errors
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err.type === "entity.parse.failed") {
    console.error("[HTTP] JSON parse error:", err.message);
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }
  next(err);
});

// Mount routes
app.use(webhookRouter);

// Start server
const server = app.listen(config.agent.port, () => {
  console.log("═══════════════════════════════════════════");
  console.log("  🤖 Farid — WhatsApp AI Productivity Agent");
  console.log("═══════════════════════════════════════════");
  console.log(`  Port:      ${config.agent.port}`);
  console.log(`  Owner:     ${config.agent.ownerNumber}`);
  console.log(`  Instance:  ${config.evolution.instance}`);
  console.log(`  Model:     ${config.hackclub.model}`);
  console.log(`  Timezone:  ${config.agent.timezone}`);
  console.log("═══════════════════════════════════════════");
  console.log(`  Webhook URL: http://localhost:${config.agent.port}/webhook`);
  console.log("  Health:      http://localhost:" + config.agent.port + "/health");
  console.log("═══════════════════════════════════════════\n");

  // Start scheduled jobs after server is listening
  startScheduler();

  console.log("\n[Farid] Ready. Waiting for messages...\n");
});

// ── Graceful shutdown ──

function shutdown(signal: string) {
  console.log(`\n[Farid] Received ${signal}. Shutting down gracefully...`);

  server.close(() => {
    console.log("[Farid] HTTP server closed.");
    closeDb();
    console.log("[Farid] Database closed.");
    process.exit(0);
  });

  // Force shutdown after 5 seconds
  setTimeout(() => {
    console.error("[Farid] Forced shutdown after timeout.");
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
