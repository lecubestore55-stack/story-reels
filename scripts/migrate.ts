import { readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "../lib/db";

export async function migrate() {
  const sql = readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8");
  await pool.query(sql);
}

if (process.argv[1] && process.argv[1].includes("migrate")) {
  migrate()
    .then(() => {
      console.log("Database schema is up to date.");
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
