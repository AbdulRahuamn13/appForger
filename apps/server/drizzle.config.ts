import { defineConfig } from "drizzle-kit";

// Only needed if you change src/db/schema.ts and want drizzle-kit to diff it;
// the server applies src/db/migrations.ts itself on startup.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
