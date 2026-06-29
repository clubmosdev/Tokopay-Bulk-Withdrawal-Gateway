import { getDb } from "./db";
import { buildServer } from "./server";
import { createWorker } from "./worker";
import { PORT } from "./config";

/**
 * Entrypoint. Initializes the embedded DB, starts the HTTP server and the
 * in-process parallel worker together (PGlite is single-process), and wires up
 * graceful shutdown.
 */
async function main() {
  const db = await getDb();

  const worker = createWorker(db);
  worker.start();

  const app = buildServer(db);
  const server = app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] tokopay-bulk-withdrawal listening on :${PORT}`);
  });

  const shutdown = async (sig: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n[app] ${sig} received — shutting down…`);
    server.close();
    await worker.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[app] fatal:", e);
  process.exit(1);
});
