import { config as loadEnv } from "dotenv";
import path from "node:path";
import { execSync } from "node:child_process";
import { Client } from "pg";
import type EmbeddedPostgres from "embedded-postgres";
import { startLocalPostgres, stopLocalPostgres } from "../scripts/local-db";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

let startedHere = false;
let handle: EmbeddedPostgres | undefined;

async function isReachable() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

export async function setup() {
  if (!(await isReachable())) {
    handle = await startLocalPostgres();
    startedHere = true;
    execSync("npx prisma migrate deploy", { stdio: "inherit" });
  }
}

export async function teardown() {
  if (startedHere && handle) {
    await stopLocalPostgres(handle);
  }
}
