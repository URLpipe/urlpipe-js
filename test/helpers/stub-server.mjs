// A real local HTTP server the tests point the client at. Each test queues
// the responses it wants; the server records every request it receives.
import { createServer } from "node:http";

export const QUOTA_HEADERS = {
  "X-Result-Token": "tok_123",
  "X-Cache": "miss",
  "X-Processing-Time-Ms": "4182",
  "X-Quota-Cost": "1",
  "X-Quota-Limit": "1000",
  "X-Quota-Remaining": "943",
  "X-Quota-Overage": "0",
  "X-Quota-Reset": "2026-08-31T23:59:59Z",
  "X-Concurrency-Limit": "3",
};

export async function startStub() {
  const requests = [];
  const queue = [];
  let fallback = null;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const record = {
        method: req.method,
        path: req.url,
        headers: req.headers,
        raw,
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(record);
      const reply = queue.shift() ?? fallback;
      if (!reply) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "stub has no response queued" }));
        return;
      }
      if (reply.destroy) {
        req.socket.destroy();
        return;
      }
      const send = () => {
        res.writeHead(reply.status ?? 200, reply.headers ?? {});
        res.end(reply.body ?? "");
      };
      if (reply.delay) setTimeout(send, reply.delay);
      else send();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** Queue one response. `body` objects are sent as JSON. */
    reply(status, body = "", headers = {}) {
      const isJson = typeof body !== "string";
      queue.push({
        status,
        body: isJson ? JSON.stringify(body) : body,
        headers: { "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", ...headers },
      });
    },
    replyRaw(options) {
      queue.push(options);
    },
    /** The response used once the queue is empty. */
    always(status, body = "", headers = {}) {
      const isJson = typeof body !== "string";
      fallback = {
        status,
        body: isJson ? JSON.stringify(body) : body,
        headers: { "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", ...headers },
      };
    },
    reset() {
      requests.length = 0;
      queue.length = 0;
      fallback = null;
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
