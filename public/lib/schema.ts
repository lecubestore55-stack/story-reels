import { readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "./db";

let ready: Promise<void> | null = null;

/** Create tables on first use, so the web app works even before the worker has started. */
export function ensureSchema() {
  if (!ready) {
    const sql = readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8");
    ready = pool.query(sql).then(() => undefined).catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}
