import { WebSocket, WebSocketServer } from "ws";
import type { Server } from "node:http";

/** Local v2 wire with inclusive resume; no external Jetstream dependency in E2E. */
export function attachJetstream(server: Server) {
  const sockets = new WebSocketServer({
    server,
    path: "/xrpc/network.bsky.jetstream.subscribeEvents",
  });
  let seq = 0;
  const history: Array<{ seq: number; message: string }> = [];
  function emit(kind: string, did: string, fields: Record<string, unknown>) {
    const payload = {
      $type: `network.bsky.jetstream.subscribeEvents#${kind}`,
      seq: ++seq,
      did,
      time: new Date().toISOString(),
      ...fields,
    };
    const message = JSON.stringify({ $type: "message", payload });
    history.push({ seq, message });
    for (const socket of sockets.clients)
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
  const heartbeat = () =>
    emit("identity", "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", {
      identity: { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" },
    });
  sockets.on("connection", (socket, request) => {
    const cursor = Number(
      new URL(request.url!, "http://localhost").searchParams.get("cursor"),
    );
    if (cursor)
      for (const event of history)
        if (event.seq >= cursor) socket.send(event.message);
    heartbeat();
  });
  const timer = setInterval(heartbeat, 250);
  server.on("close", () => {
    clearInterval(timer);
    sockets.close();
  });
  return {
    commit(
      did: string,
      collection: string,
      rkey: string,
      rev: number,
      record?: { cid: string; value: unknown },
    ) {
      const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
      let value = rev,
        tid = "";
      do {
        tid = alphabet[value % 32] + tid;
        value = Math.floor(value / 32);
      } while (value);
      emit("commit", did, {
        operation: record ? "update" : "delete",
        collection,
        rkey,
        rev: tid.padStart(13, "2"),
        ...(record ? { cid: record.cid, record: record.value } : {}),
      });
    },
  };
}
