import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { resolveStreamService } from "~/server/jetstream/endpoint";

it("prefers and caches v2 on a custom service that supports both protocols", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({
    server,
    handleProtocols: () => "xrpc.v1.json",
  });
  let connections = 0;
  sockets.on("connection", () => {
    connections++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  const service = `http://127.0.0.1:${address.port}`;
  try {
    expect(await resolveStreamService(service)).toBe(service);
    expect(await resolveStreamService(service)).toBe(service);
    expect(connections).toBe(1);
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) =>
      sockets.close(() => server.close(() => resolve())),
    );
  }
});

it.each([404, 501, 401, 403, 429, 503])(
  "only selects legacy for unsupported v2 responses, HTTP %s",
  async (status) => {
    const server = createServer();
    let attempts = 0;
    server.on("upgrade", (_request, socket) => {
      attempts++;
      socket.end(
        `HTTP/1.1 ${status} Test\r\nRetry-After: 75\r\nContent-Length: 0\r\n\r\n`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    const service = `http://127.0.0.1:${address.port}`;
    try {
      if ([404, 501].includes(status)) {
        expect(await resolveStreamService(service)).toBe(
          `${service}/subscribe`,
        );
      } else if ([401, 403].includes(status)) {
        expect(await resolveStreamService(service)).toBe(service);
      } else {
        await expect(resolveStreamService(service)).rejects.toMatchObject({
          status,
          retryAfterMs: 75_000,
        });
        await expect(resolveStreamService(service)).rejects.toMatchObject({
          status,
        });
        expect(attempts).toBe(2);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
