import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { reset } from "drizzle-seed";
import * as schema from "../src/server/db/schema";

async function waitForApp(url: string, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export default async function globalSetup() {
  await waitForApp("http://localhost:3000/api/health");

  const client = createClient({ url: "http://127.0.0.1:8081" });
  const db = drizzle({ client, schema });

  await reset(db, schema);

  client.close();
}
