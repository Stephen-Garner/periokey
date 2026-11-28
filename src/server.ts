import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { loadProfiles } from "./load-profiles.ts";
import { createOsInjector, isolatedDesktopWarning } from "./injector.ts";
import { readConfig } from "./config.ts";
import { createEngine } from "./engine.ts";

try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const config = readConfig(process.env);
const root = fileURLToPath(new URL("..", import.meta.url));
const profiles = loadProfiles(join(root, "profiles"));
if (!profiles.has(config.profile)) {
  throw new Error(
    `PMS_PROFILE "${config.profile}" not found. Choose one of: ${[...profiles.keys()].join(", ")}`,
  );
}

const clients = new Set<WebSocket>();
const engine = createEngine({
  config,
  profiles,
  emit(message) {
    const text = JSON.stringify(message);
    for (const client of clients) client.send(text);
  },
  makeInjector: () =>
    createOsInjector(process.platform, (desktop) => {
      console.log(
        `[live] helper started (desktop: ${desktop}, hotkey: ${config.hotkey})`,
      );
      const warning = isolatedDesktopWarning(desktop);
      if (!warning) return;
      console.warn(`[live] WARNING: ${warning.replace(/^R/, "r")}`);
      engine.setDesktopWarning(warning);
    }),
});

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer((request, response) => {
  const path = request.url === "/" ? "/index.html" : (request.url ?? "");
  const type = contentTypes[extname(path)];
  if (!type || !/^\/[a-z-]+\.[a-z]+$/.test(path)) {
    response.writeHead(404).end();
    return;
  }
  readFile(join(root, "public", path))
    .then((body) => response.writeHead(200, { "content-type": type }).end(body))
    .catch(() => response.writeHead(404).end());
});

const allowedOrigins = new Set([
  `http://127.0.0.1:${config.port}`,
  `http://localhost:${config.port}`,
]);
const sockets = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: ({ origin }: { origin: string }) => allowedOrigins.has(origin),
});

sockets.on("connection", (client) => {
  clients.add(client);
  client.on("close", () => clients.delete(client));
  client.on("message", (data, isBinary) => {
    if (isBinary) {
      if (Buffer.isBuffer(data)) engine.sendAudio(data);
      return;
    }
    try {
      engine.handle(JSON.parse(String(data)));
    } catch {
      return;
    }
  });
  engine.broadcastState();
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`PerioKey is running: open http://localhost:${config.port}`);
  console.log(
    `Mode ${config.mode}, profile ${config.profile}, speech ${config.provider ?? "none (practice by typing)"}`,
  );
});
