import "dotenv/config";

import { migrate } from "drizzle-orm/libsql/migrator";

import { db } from ".";

migrate(db, { migrationsFolder: "src/server/db/migrations" })
  .then(() => {
    console.log("Migrations completed!");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Migrations failed!", err);
    process.exit(1);
  });
