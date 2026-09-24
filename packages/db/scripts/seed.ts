import { todayIn } from "@vyapaar/core";
import { createDb, seedBusinessDefaults, seedReferenceData } from "../src/index.js";
import { businesses } from "../src/schema/index.js";

/**
 * Seeds reference data, and (for local development) a first business with
 * default roles, units, series and settings when the database has none.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const { db, pool } = createDb(url, { max: 1 });
try {
  await seedReferenceData(db);
  const existing = await db.select({ id: businesses.id }).from(businesses).limit(1);
  if (existing.length === 0 && process.env.SEED_DEMO_BUSINESS === "1") {
    const [biz] = await db
      .insert(businesses)
      .values({ legalName: process.env.SEED_BUSINESS_NAME ?? "Demo Distributors", stateCode: process.env.SEED_STATE_CODE ?? "23" })
      .returning({ id: businesses.id });
    await seedBusinessDefaults(db, biz!.id, todayIn());
    console.log(`Created demo business ${biz!.id}`);
  }
  console.log("Seed complete");
} finally {
  await pool.end();
}
