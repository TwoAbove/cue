import type { PersistenceAdapter } from "../src/persistence/types";
import { BunPostgresAdapter } from "./adapters/postgres";
import { BunRedisAdapter } from "./adapters/redis";

const POSTGRES_URL = "postgres://postgres:postgres@localhost:5433/cue_test";
const REDIS_URL = "redis://localhost:6379";

const SIMULATED_LATENCY_MS = Number.parseFloat(process.env.LATENCY_MS ?? "0");
const SUSTAINED_DURATION_SEC = Number.parseFloat(process.env.DURATION_SEC ?? "5");

interface BenchResult {
  name: string;
  adapter: string;
  eventsPerSec: number;
  totalMs: number;
  events: number;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

async function simulateLatency(): Promise<void> {
  if (SIMULATED_LATENCY_MS > 0) {
    await new Promise((r) => setTimeout(r, SIMULATED_LATENCY_MS));
  }
}

function generateEventData(size: "small" | "medium" | "large"): string {
  const base = {
    entityDefName: "Counter",
    schemaVersion: 1,
    handler: "increment",
    payload: [1],
    returnVal: undefined,
    patches: [{ op: "replace" as const, path: ["count"], value: 0 }],
  };

  if (size === "small") {
    return JSON.stringify(base);
  }

  if (size === "medium") {
    return JSON.stringify({
      ...base,
      payload: [{ data: "x".repeat(500) }],
    });
  }

  return JSON.stringify({
    ...base,
    payload: [{ data: "x".repeat(5000) }],
  });
}

async function benchSequentialWrites(
  adapter: PersistenceAdapter,
  adapterName: string,
  count: number,
  payloadSize: "small" | "medium" | "large",
): Promise<BenchResult> {
  const entityId = `bench-seq-${Date.now()}`;
  const data = generateEventData(payloadSize);

  const start = performance.now();
  for (let i = 1; i <= count; i++) {
    await simulateLatency();
    await adapter.commitEvent(entityId, BigInt(i), data);
  }
  const elapsed = performance.now() - start;

  return {
    name: `Sequential writes (${payloadSize} payload)`,
    adapter: adapterName,
    eventsPerSec: Math.round((count / elapsed) * 1000),
    totalMs: Math.round(elapsed),
    events: count,
  };
}

async function benchSustainedLoad(
  adapter: PersistenceAdapter,
  adapterName: string,
  concurrency: number,
): Promise<BenchResult> {
  const durationMs = SUSTAINED_DURATION_SEC * 1000;
  const data = generateEventData("small");
  let totalEvents = 0;
  const deadline = performance.now() + durationMs;

  const start = performance.now();

  const workers = Array.from({ length: concurrency }, async (_, workerId) => {
    const entityId = `bench-sustained-${Date.now()}-${workerId}`;
    let version = 0n;
    while (performance.now() < deadline) {
      version += 1n;
      await simulateLatency();
      await adapter.commitEvent(entityId, version, data);
      totalEvents++;
    }
  });

  await Promise.all(workers);

  const elapsed = performance.now() - start;

  return {
    name: `Sustained load (${concurrency} workers, ${SUSTAINED_DURATION_SEC}s)`,
    adapter: adapterName,
    eventsPerSec: Math.round((totalEvents / elapsed) * 1000),
    totalMs: Math.round(elapsed),
    events: totalEvents,
  };
}

async function benchParallelWrites(
  adapter: PersistenceAdapter,
  adapterName: string,
  entityCount: number,
  eventsPerEntity: number,
  payloadSize: "small" | "medium" | "large",
): Promise<BenchResult> {
  const data = generateEventData(payloadSize);
  const totalEvents = entityCount * eventsPerEntity;

  const start = performance.now();

  const promises = Array.from({ length: entityCount }, async (_, i) => {
    const entityId = `bench-par-${Date.now()}-${i}`;
    for (let j = 1; j <= eventsPerEntity; j++) {
      await simulateLatency();
      await adapter.commitEvent(entityId, BigInt(j), data);
    }
  });

  await Promise.all(promises);
  const elapsed = performance.now() - start;

  return {
    name: `Parallel writes (${entityCount} entities × ${eventsPerEntity} events, ${payloadSize})`,
    adapter: adapterName,
    eventsPerSec: Math.round((totalEvents / elapsed) * 1000),
    totalMs: Math.round(elapsed),
    events: totalEvents,
  };
}

async function benchReads(
  adapter: PersistenceAdapter,
  adapterName: string,
  eventCount: number,
): Promise<BenchResult> {
  const entityId = `bench-read-${Date.now()}`;
  const data = generateEventData("small");

  for (let i = 1; i <= eventCount; i++) {
    await adapter.commitEvent(entityId, BigInt(i), data);
  }

  const iterations = 100;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await adapter.getEvents(entityId, 0n);
  }
  const elapsed = performance.now() - start;

  const readsPerSec = Math.round((iterations / elapsed) * 1000);

  return {
    name: `Read ${eventCount} events (${iterations} iterations)`,
    adapter: adapterName,
    eventsPerSec: readsPerSec * eventCount,
    totalMs: Math.round(elapsed),
    events: iterations * eventCount,
  };
}

function printResults(results: BenchResult[]): void {
  console.log("\n" + "=".repeat(80));
  console.log("BENCHMARK RESULTS");
  console.log("=".repeat(80));

  const grouped = results.reduce(
    (acc, r) => {
      if (!acc[r.adapter]) acc[r.adapter] = [];
      acc[r.adapter].push(r);
      return acc;
    },
    {} as Record<string, BenchResult[]>,
  );

  for (const [adapter, adapterResults] of Object.entries(grouped)) {
    console.log(`\n${adapter}:`);
    console.log("-".repeat(70));

    for (const r of adapterResults) {
      console.log(
        `  ${r.name.padEnd(55)} ${formatNumber(r.eventsPerSec).padStart(8)} events/sec`,
      );
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));

  const pgSeq = results.find(
    (r) =>
      r.adapter === "PostgreSQL" &&
      r.name.includes("Sequential") &&
      r.name.includes("small"),
  );
  const redisSeq = results.find(
    (r) =>
      r.adapter === "Redis" &&
      r.name.includes("Sequential") &&
      r.name.includes("small"),
  );

  if (pgSeq && redisSeq) {
    console.log("\nSequential write throughput (small payloads):");
    console.log(`  PostgreSQL: ${formatNumber(pgSeq.eventsPerSec)} events/sec`);
    console.log(`  Redis:      ${formatNumber(redisSeq.eventsPerSec)} events/sec`);
    console.log(
      `  Redis is ${(redisSeq.eventsPerSec / pgSeq.eventsPerSec).toFixed(1)}x faster`,
    );
  }

  console.log("\n" + "=".repeat(80));
}

async function main() {
  console.log("Starting persistence benchmark...\n");
  console.log("PostgreSQL:", POSTGRES_URL);
  console.log("Redis:", REDIS_URL);
  console.log(`Simulated latency: ${SIMULATED_LATENCY_MS}ms (set LATENCY_MS env var)`);
  console.log(`Sustained duration: ${SUSTAINED_DURATION_SEC}s (set DURATION_SEC env var)`);

  const pg = new BunPostgresAdapter(POSTGRES_URL);
  const redis = new BunRedisAdapter(REDIS_URL);

  try {
    console.log("\nInitializing adapters...");
    await pg.init();
    await redis.connect();

    console.log("Resetting databases...");
    await pg.reset();
    await redis.reset();

    const results: BenchResult[] = [];

    console.log("\nRunning benchmarks...\n");

    console.log("  [1/12] PostgreSQL sequential writes (small)...");
    results.push(await benchSequentialWrites(pg, "PostgreSQL", 500, "small"));

    console.log("  [2/12] Redis sequential writes (small)...");
    results.push(await benchSequentialWrites(redis, "Redis", 500, "small"));

    console.log("  [3/12] PostgreSQL parallel writes (10 entities)...");
    results.push(await benchParallelWrites(pg, "PostgreSQL", 10, 50, "small"));

    console.log("  [4/12] Redis parallel writes (10 entities)...");
    results.push(await benchParallelWrites(redis, "Redis", 10, 50, "small"));

    console.log("  [5/12] PostgreSQL parallel writes (50 entities)...");
    results.push(await benchParallelWrites(pg, "PostgreSQL", 50, 20, "small"));

    console.log("  [6/12] Redis parallel writes (50 entities)...");
    results.push(await benchParallelWrites(redis, "Redis", 50, 20, "small"));

    console.log("  [7/12] PostgreSQL sustained (10 workers)...");
    results.push(await benchSustainedLoad(pg, "PostgreSQL", 10));

    console.log("  [8/12] Redis sustained (10 workers)...");
    results.push(await benchSustainedLoad(redis, "Redis", 10));

    console.log("  [9/12] PostgreSQL sustained (50 workers)...");
    results.push(await benchSustainedLoad(pg, "PostgreSQL", 50));

    console.log("  [10/12] Redis sustained (50 workers)...");
    results.push(await benchSustainedLoad(redis, "Redis", 50));

    console.log("  [11/12] PostgreSQL reads...");
    results.push(await benchReads(pg, "PostgreSQL", 100));

    console.log("  [12/12] Redis reads...");
    results.push(await benchReads(redis, "Redis", 100));

    printResults(results);
  } finally {
    await pg.close();
    await redis.close();
  }
}

main().catch(console.error);
