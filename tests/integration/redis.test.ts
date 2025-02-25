/**
 * Integration test against real Redis 7.
 *
 * Run with: docker compose up -d && npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Redis } from "ioredis";
import { parseRedisInfo, type RedisInfo } from "../../src/parsers/info.js";
import { analyzeMemory, formatMemoryAnalysis } from "../../src/analyzers/memory.js";
import {
  parseSlowlogEntries,
  analyzeSlowlog,
  formatSlowlogAnalysis,
} from "../../src/analyzers/slowlog.js";
import {
  parseClientList,
  analyzeClients,
  formatClientAnalysis,
} from "../../src/analyzers/clients.js";
import { analyzeKeyspace, formatKeyspaceAnalysis } from "../../src/analyzers/keyspace.js";
import {
  parseLatencyLatest,
  analyzeLatency,
  formatLatencyAnalysis,
} from "../../src/analyzers/latency.js";

const REDIS_URL = process.env.TEST_REDIS_URL || "redis://localhost:16379";

let redis: Redis;
let info: RedisInfo;

describe("Redis Integration Tests — All 6 Tools", () => {
  beforeAll(async () => {
    redis = new Redis(REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
    });
    await redis.connect();

    // Populate with realistic data
    const pipeline = redis.pipeline();

    // 200 string keys
    for (let i = 0; i < 200; i++) {
      pipeline.set(`user:${i}`, JSON.stringify({ name: `User ${i}`, email: `user${i}@test.com` }));
    }

    // 100 hash keys
    for (let i = 0; i < 100; i++) {
      pipeline.hset(`product:${i}`, {
        name: `Product ${i}`,
        price: String(Math.random() * 100),
        category: ["electronics", "books", "clothing", "food"][i % 4],
      });
    }

    // 50 set keys
    for (let i = 0; i < 50; i++) {
      pipeline.sadd(`tags:${i}`, "tag1", "tag2", "tag3", `tag${i}`);
    }

    // 50 sorted set keys
    for (let i = 0; i < 50; i++) {
      pipeline.zadd(`leaderboard:${i}`, i * 10, `player${i}`);
    }

    // 50 list keys
    for (let i = 0; i < 50; i++) {
      pipeline.rpush(`queue:${i}`, `item1`, `item2`, `item3`);
    }

    // Some keys with TTLs
    for (let i = 0; i < 100; i++) {
      pipeline.setex(`cache:${i}`, 3600, `cached-value-${i}`);
    }

    // A few large keys
    pipeline.set("large:blob", "x".repeat(10000));
    pipeline.hset("large:hash", Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`field${i}`, `value-${i}-${"x".repeat(100)}`])
    ));

    await pipeline.exec();

    // Parse INFO for analysis
    const rawInfo = await redis.info();
    info = parseRedisInfo(rawInfo);
  }, 30000);

  afterAll(async () => {
    if (redis) {
      await redis.flushdb();
      await redis.quit();
    }
  });

  // Tool 1: analyze_memory
  describe("analyze_memory", () => {
    it("returns memory analysis with real data", () => {
      const analysis = analyzeMemory(info);
      const output = formatMemoryAnalysis(analysis);
      expect(output).toContain("Memory Analysis");
      expect(output).toContain("Used Memory");
      expect(output).toContain("Fragmentation Ratio");
      expect(analysis.summary.length).toBeGreaterThan(0);
    });
  });

  // Tool 2: analyze_slowlog
  describe("analyze_slowlog", () => {
    it("returns slowlog analysis (may be empty for fresh server)", async () => {
      const rawEntries = await redis.call("SLOWLOG", "GET", "128") as unknown[];
      const entries = parseSlowlogEntries(rawEntries);
      const analysis = analyzeSlowlog(entries, 10000);
      const output = formatSlowlogAnalysis(analysis);
      expect(output).toContain("Slowlog Analysis");
    });
  });

  // Tool 3: analyze_clients
  describe("analyze_clients", () => {
    it("returns client analysis with at least our connection", async () => {
      const clientListRaw = await redis.call("CLIENT", "LIST") as string;
      const clients = parseClientList(clientListRaw);
      const analysis = analyzeClients(clients, info);
      const output = formatClientAnalysis(analysis);
      expect(output).toContain("Client Analysis");
      expect(clients.length).toBeGreaterThanOrEqual(1);
    });
  });

  // Tool 4: analyze_keyspace
  describe("analyze_keyspace", () => {
    it("returns keyspace analysis with our populated data", () => {
      const analysis = analyzeKeyspace(info);
      const output = formatKeyspaceAnalysis(analysis);
      expect(output).toContain("Keyspace Analysis");
    });
  });

  // Tool 5: analyze_latency
  describe("analyze_latency", () => {
    it("returns latency analysis (may be empty without latency-monitor-threshold)", async () => {
      const rawLatest = await redis.call("LATENCY", "LATEST") as unknown[];
      const events = parseLatencyLatest(rawLatest);
      const analysis = analyzeLatency(events);
      const output = formatLatencyAnalysis(analysis);
      expect(output).toContain("Latency Analysis");
    });
  });

  // Key count verification
  describe("data verification", () => {
    it("has expected number of keys", async () => {
      const dbsize = await redis.dbsize();
      // 200 strings + 100 hashes + 50 sets + 50 sorted sets + 50 lists + 100 cache + 2 large = 552
      expect(dbsize).toBeGreaterThanOrEqual(500);
    });
  });
});
