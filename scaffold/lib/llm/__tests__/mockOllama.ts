import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in Ollama on 127.0.0.1 (random port) for tests: GET /api/tags lists
 * `models`; POST /api/pull streams NDJSON progress like Ollama's and then adds
 * the model to `models`. Every mock gets a fresh random port; `listen()` / `close()`
 * simulate its daemon starting and stopping on that port. Never touches a real Ollama.
 */
export type MockOllama = {
  host: string;
  port: number;
  models: Array<{ name: string; details?: Record<string, unknown> }>;
  pulls: string[];
  /** Make /api/pull fail with Ollama's error line. */
  pullError?: string;
  /** "stall": send a little progress, then nothing (connection kept open). "die": drop the connection midway. */
  pullMode?: "ok" | "stall" | "die";
  /** Set once the client closed a pull connection (cancel / idle timeout released it). */
  pullClientClosed: boolean;
  listen: () => Promise<void>;
  close: () => Promise<void>;
};

export async function startMockOllama(
  models: MockOllama["models"] = [],
  opts: { listening?: boolean } = {},
): Promise<MockOllama> {
  const mock = { models, pulls: [] as string[], pullClientClosed: false } as MockOllama;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: mock.models }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/pull") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const { model } = JSON.parse(body);
        mock.pulls.push(model);
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        const line = (o: unknown) => res.write(JSON.stringify(o) + "\n");
        line({ status: "pulling manifest" });
        if (mock.pullError) {
          line({ error: mock.pullError });
          res.end();
          return;
        }
        res.on("close", () => {
          if (!res.writableFinished) mock.pullClientClosed = true;
        });
        if (mock.pullMode === "stall") {
          line({ status: "pulling aaa", digest: "sha256:aaa", total: 1000, completed: 10 });
          return; // never another byte
        }
        if (mock.pullMode === "die") {
          line({ status: "pulling aaa", digest: "sha256:aaa", total: 1000, completed: 300 });
          await new Promise((r) => setTimeout(r, 10));
          res.socket?.destroy();
          return;
        }
        const total = 2_000_000_000;
        for (const completed of [0, 500_000_000, 1_000_000_000, 2_000_000_000]) {
          line({ status: "pulling aaa", digest: "sha256:aaa", total, completed });
          await new Promise((r) => setTimeout(r, 5));
        }
        line({ status: "pulling bbb", digest: "sha256:bbb", total: 1000, completed: 1000 });
        line({ status: "verifying sha256 digest" });
        line({ status: "writing manifest" });
        mock.models.push({ name: model, details: { parameter_size: "7.6B", family: "qwen2" } });
        line({ status: "success" });
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end("404 page not found");
  });

  // Reserve a port, then (optionally) leave it closed to play a stopped daemon.
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  mock.port = (server.address() as AddressInfo).port;
  mock.host = `http://127.0.0.1:${mock.port}`;
  let listening = true;
  mock.close = () =>
    new Promise<void>((r) => {
      if (!listening) return r();
      listening = false;
      server.closeAllConnections?.();
      server.close(() => r());
    });
  mock.listen = () =>
    new Promise<void>((r) => {
      if (listening) return r();
      listening = true;
      server.listen(mock.port, "127.0.0.1", () => r());
    });
  if (opts.listening === false) await mock.close();
  return mock;
}
