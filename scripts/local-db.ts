import EmbeddedPostgres from "embedded-postgres";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = path.resolve(process.cwd(), ".pgdata");
const PORT = 54329;
const USER = "postgres";
const PASSWORD = "postgres";
const DATABASE = "car_rental_dev";

export function createLocalPostgres() {
  return new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
    // 300: peak theoretical demand across all 6 test files running together
    // is ~255 connections (29 PrismaClient pools at the 2*physicalCpus+1
    // default of 5 each on this 2-core host, plus the 110-max pg.Pool in
    // vehicle-blocks-availability.test.ts), so 300 keeps ~45 connections of
    // headroom above worst case.
    postgresFlags: ["-c", "max_connections=300"],
  });
}

export async function startLocalPostgres() {
  const pg = createLocalPostgres();
  const alreadyInitialised = fs.existsSync(path.join(DATA_DIR, "PG_VERSION"));
  if (!alreadyInitialised) {
    await pg.initialise();
  }
  await pg.start();
  try {
    await pg.createDatabase(DATABASE);
  } catch {
    // database already exists
  }
  return pg;
}

export async function stopLocalPostgres(pg: EmbeddedPostgres) {
  await pg.stop();
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "start") {
    await startLocalPostgres();
    console.log(`local postgres up on port ${PORT}, database "${DATABASE}"`);
  } else if (cmd === "stop") {
    const pg = createLocalPostgres();
    await stopLocalPostgres(pg);
    console.log("local postgres stopped");
  } else {
    console.error("usage: tsx scripts/local-db.ts <start|stop>");
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
