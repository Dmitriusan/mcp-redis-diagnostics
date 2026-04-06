#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { parseRedisInfo, type RedisInfo } from "./parsers/info.js";
import { analyzeMemory, formatMemoryAnalysis } from "./analyzers/memory.js";
import {
  parseSlowlogEntries,
  analyzeSlowlog,
  formatSlowlogAnalysis,
} from "./analyzers/slowlog.js";
import {
  parseClientList,
  analyzeClients,
  formatClientAnalysis,
} from "./analyzers/clients.js";
import { analyzeKeyspace, formatKeyspaceAnalysis } from "./analyzers/keyspace.js";
import {
  parseLatencyLatest,
  parseLatencyHistory,
  analyzeLatency,
  formatLatencyAnalysis,
} from "./analyzers/latency.js";
import { analyzeConfig, formatConfigAnalysis } from "./analyzers/config.js";
import { analyzeReplication, formatReplicationAnalysis } from "./analyzers/replication.js";

// Handle --help
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`mcp-redis-diagnostics v0.1.9 — MCP server for Redis diagnostics

Usage:
  mcp-redis-diagnostics [options]

Options:
  --help, -h   Show this help message

Environment:
  REDIS_URL    Redis connection string (default: redis://localhost:6379)

Tools provided:
  analyze_memory       Memory usage, fragmentation, eviction risk
  analyze_slowlog      Slow command detection and optimization advice
  analyze_clients      Client connections, blocked clients, idle detection
  analyze_keyspace     Key distribution, TTL coverage, hit/miss rate
  analyze_latency      Fork, AOF, command latency spike detection
  analyze_config       Dangerous configuration detection and hardening
  analyze_replication  Replication health, lag, backlog, link status
  analyze_performance  Unified health assessment (all analyzers combined)`);
  process.exit(0);
}

// --- Redis connection ---
import { Redis } from "ioredis";

let redis: Redis | null = null;

const REDIS_CONNECTION_ERROR_RE =
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|NOAUTH|ERR AUTH|wrong number of arguments for 'auth'|Connection is closed|max retries per request/i;

function wrapRedisError(context: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const sanitized = msg.replace(/\/\/[^@]+@/g, "//****:****@");
  if (REDIS_CONNECTION_ERROR_RE.test(msg)) {
    return `Error ${context}: ${sanitized}\n\nThis looks like a Redis connection issue. Check your configuration:\n- Set REDIS_URL environment variable (e.g., redis://localhost:6379)\n- For authenticated Redis: REDIS_URL=redis://:password@host:6379\n- Ensure the Redis server is running and accessible`;
  }
  return `Error ${context}: ${sanitized}`;
}

async function getRedis(): Promise<Redis> {
  if (redis) return redis;

  const url = process.env.REDIS_URL || "redis://localhost:6379";
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
  });
  try {
    await client.connect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const sanitized = msg.replace(/\/\/[^@]+@/g, "//****:****@");
    throw new Error(
      `Cannot connect to Redis: ${sanitized}\n\nConfigure via REDIS_URL environment variable (e.g., redis://localhost:6379)\nFor authenticated Redis: REDIS_URL=redis://:password@host:6379`
    );
  }
  redis = client;
  return client;
}

async function getInfo(): Promise<RedisInfo> {
  const client = await getRedis();
  const raw = await client.info();
  return parseRedisInfo(raw);
}

async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

// --- MCP Server ---
const server = new McpServer({
  name: "mcp-redis-diagnostics",
  version: "0.1.9",
});

// Tool 1: analyze_memory
server.tool(
  "analyze_memory",
  "Analyze Redis memory usage. Detects high fragmentation, RSS overhead, maxmemory pressure, eviction issues, and swap risk. Provides actionable recommendations for memory optimization.",
  {},
  async () => {
    try {
      const info = await getInfo();
      const analysis = analyzeMemory(info);
      return { content: [{ type: "text", text: formatMemoryAnalysis(analysis) }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: wrapRedisError("analyzing memory", err),
          },
        ],
      };
    }
  }
);

// Tool 2: analyze_slowlog
server.tool(
  "analyze_slowlog",
  "Analyze Redis SLOWLOG to find slow commands. Detects dangerous O(N) commands (KEYS, SMEMBERS, HGETALL, LRANGE, SORT, FLUSHDB, FLUSHALL), identifies latency hotspots, and recommends safer alternatives (SCAN, SSCAN, HSCAN, bounded ranges, sorted sets).",
  {
    count: z
      .number()
      .default(128)
      .describe("Number of slowlog entries to retrieve (default: 128)"),
  },
  async ({ count }) => {
    try {
      const client = await getRedis();
      const info = await getInfo();
      const threshold = parseInt(
        info.server?.["slowlog-log-slower-than"] || "10000",
        10
      );

      const rawEntries = await client.call("SLOWLOG", "GET", String(count));
      const entries = parseSlowlogEntries(rawEntries as unknown[]);
      const analysis = analyzeSlowlog(entries, threshold);
      return {
        content: [{ type: "text", text: formatSlowlogAnalysis(analysis) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: wrapRedisError("analyzing slowlog", err),
          },
        ],
      };
    }
  }
);

// Tool 3: analyze_clients
server.tool(
  "analyze_clients",
  "Analyze Redis client connections. Detects blocked clients, idle connections, output buffer issues, connection pool saturation, and pub/sub subscriber patterns.",
  {},
  async () => {
    try {
      const client = await getRedis();
      const info = await getInfo();
      const clientListRaw = await client.call("CLIENT", "LIST") as string;
      const clients = parseClientList(clientListRaw);
      const analysis = analyzeClients(clients, info);
      return {
        content: [{ type: "text", text: formatClientAnalysis(analysis) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: wrapRedisError("analyzing clients", err),
          },
        ],
      };
    }
  }
);

// Tool 4: analyze_keyspace
server.tool(
  "analyze_keyspace",
  "Analyze Redis keyspace distribution. Checks TTL coverage, cache hit/miss rates, database distribution balance, and expiry patterns.",
  {},
  async () => {
    try {
      const info = await getInfo();
      const analysis = analyzeKeyspace(info);
      return {
        content: [{ type: "text", text: formatKeyspaceAnalysis(analysis) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: wrapRedisError("analyzing keyspace", err),
          },
        ],
      };
    }
  }
);

// Tool 6: analyze_latency
server.tool(
  "analyze_latency",
  "Analyze Redis latency events. Detects fork latency spikes (RDB/AOF), AOF fsync delays, slow command processing, eviction/expiry cycle delays, and active defragmentation impact. Requires latency-monitor-threshold to be set.",
  {},
  async () => {
    try {
      const client = await getRedis();
      const rawLatest = await client.call("LATENCY", "LATEST") as unknown[];
      const events = parseLatencyLatest(rawLatest);

      // Get history for each event
      const history: Record<string, import("./analyzers/latency.js").LatencyHistoryEntry[]> = {};
      for (const event of events) {
        try {
          const rawHistory = await client.call("LATENCY", "HISTORY", event.event) as unknown[];
          history[event.event] = parseLatencyHistory(rawHistory);
        } catch {
          // LATENCY HISTORY may not be available for all events
        }
      }

      const analysis = analyzeLatency(events, history);
      return { content: [{ type: "text", text: formatLatencyAnalysis(analysis) }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: wrapRedisError("analyzing latency", err),
          },
        ],
      };
    }
  }
);

// Tool 7: analyze_config
server.tool(
  "analyze_config",
  "Analyze Redis configuration for security and reliability risks. Flags: no maxmemory limit, unsafe eviction policy (noeviction with maxmemory set), network exposure (bind 0.0.0.0 without authentication), no requirepass, disabled persistence (both AOF and RDB off), idle connection timeout not set, TCP keepalive disabled, server frequency (hz) too low, and latency-monitor-threshold disabled (which silences the analyze_latency tool).",
  {},
  async () => {
    try {
      const client = await getRedis();
      const rawConfig = await client.call("CONFIG", "GET", "*") as string[];

      // CONFIG GET * returns flat array: [key1, val1, key2, val2, ...]
      const configMap: Record<string, string> = {};
      for (let i = 0; i < rawConfig.length; i += 2) {
        configMap[rawConfig[i]] = rawConfig[i + 1];
      }

      const analysis = analyzeConfig(configMap);
      return { content: [{ type: "text", text: formatConfigAnalysis(analysis) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: wrapRedisError("analyzing configuration", err) }],
      };
    }
  }
);

// Tool 8: analyze_replication
server.tool(
  "analyze_replication",
  "Analyze Redis replication health. For masters: reports connected replica count, per-replica state (online/wait_bgsave/send_bulk) and lag in seconds, backlog size adequacy, and partial resync offset history. For replicas: detects broken master link, high I/O lag, and full sync in progress. Works for both master and replica roles.",
  {},
  async () => {
    try {
      const info = await getInfo();
      const analysis = analyzeReplication(info);
      return { content: [{ type: "text", text: formatReplicationAnalysis(analysis) }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: wrapRedisError("analyzing replication", err),
          },
        ],
      };
    }
  }
);

// Tool 9: analyze_performance (unified)
server.tool(
  "analyze_performance",
  "Comprehensive Redis health assessment. Runs all analyzers (memory, slowlog, clients, keyspace, latency, replication, config) and produces a unified report with prioritized recommendations.",
  {
    slowlog_count: z
      .number()
      .default(128)
      .describe("Number of slowlog entries to retrieve (default: 128)"),
  },
  async ({ slowlog_count }) => {
    try {
      const client = await getRedis();
      const info = await getInfo();
      const errors: string[] = [];

      // Memory (uses INFO only — no extra commands)
      const memAnalysis = analyzeMemory(info);

      // Slowlog (may fail if SLOWLOG command is disabled via ACL)
      let slowAnalysis: ReturnType<typeof analyzeSlowlog> | null = null;
      try {
        const threshold = parseInt(
          info.server?.["slowlog-log-slower-than"] || "10000",
          10
        );
        const rawEntries = await client.call(
          "SLOWLOG",
          "GET",
          String(slowlog_count)
        );
        const entries = parseSlowlogEntries(rawEntries as unknown[]);
        slowAnalysis = analyzeSlowlog(entries, threshold);
      } catch (err) {
        errors.push(`Slowlog: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Clients (may fail if CLIENT LIST is blocked by ACL)
      let clientAnalysis: ReturnType<typeof analyzeClients> | null = null;
      try {
        const clientListRaw = await client.call("CLIENT", "LIST") as string;
        const clients = parseClientList(clientListRaw);
        clientAnalysis = analyzeClients(clients, info);
      } catch (err) {
        errors.push(`Clients: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Keyspace (uses INFO only — no extra commands)
      const ksAnalysis = analyzeKeyspace(info);

      // Latency (may not be available in all Redis versions)
      let latAnalysis: ReturnType<typeof analyzeLatency> | null = null;
      try {
        const rawLatest = await client.call("LATENCY", "LATEST") as unknown[];
        const latEvents = parseLatencyLatest(rawLatest);

        // Fetch per-event history for trend analysis (increasing latency detection)
        const latHistory: Record<string, import("./analyzers/latency.js").LatencyHistoryEntry[]> = {};
        for (const event of latEvents) {
          try {
            const rawHistory = await client.call("LATENCY", "HISTORY", event.event) as unknown[];
            latHistory[event.event] = parseLatencyHistory(rawHistory);
          } catch {
            // History may not be available for all events
          }
        }

        latAnalysis = analyzeLatency(latEvents, latHistory);
      } catch {
        // LATENCY may not be available — silently skip
      }

      // Replication (uses INFO only — no extra commands)
      const replAnalysis = analyzeReplication(info);

      // Config (may fail if CONFIG GET is blocked via ACL)
      let configAnalysis: ReturnType<typeof analyzeConfig> | null = null;
      try {
        const rawConfig = await client.call("CONFIG", "GET", "*") as string[];
        const configMap: Record<string, string> = {};
        for (let i = 0; i < rawConfig.length; i += 2) {
          configMap[rawConfig[i]] = rawConfig[i + 1];
        }
        configAnalysis = analyzeConfig(configMap);
      } catch (err) {
        errors.push(`Config: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Unified report
      const lines: string[] = [];
      lines.push("# Redis Performance Report");
      lines.push("");

      // Overall status — non-config findings have { title, recommendation };
      // ConfigFinding uses { setting, message } instead, so keep them separate
      // to avoid TypeScript union type issues when accessing f.title below.
      const allFindings = [
        ...memAnalysis.findings,
        ...(slowAnalysis?.findings ?? []),
        ...(clientAnalysis?.findings ?? []),
        ...ksAnalysis.findings,
        ...(latAnalysis?.findings ?? []),
        ...replAnalysis.findings,
      ];
      const cfgFindings = configAnalysis?.findings ?? [];
      const criticalCount =
        allFindings.filter((f) => f.severity === "CRITICAL").length +
        cfgFindings.filter((f) => f.severity === "CRITICAL").length;
      const warningCount =
        allFindings.filter((f) => f.severity === "WARNING").length +
        cfgFindings.filter((f) => f.severity === "WARNING").length;

      const overallStatus =
        criticalCount > 0
          ? `CRITICAL — ${criticalCount} critical issue(s), ${warningCount} warning(s)`
          : warningCount > 0
            ? `WARNING — ${warningCount} warning(s)`
            : "HEALTHY — no issues detected";

      lines.push(`**Overall Status:** ${overallStatus}`);
      lines.push(
        `**Redis Version:** ${info.server?.redis_version || "unknown"}`
      );
      lines.push(`**Uptime:** ${formatUptime(parseInt(info.server?.uptime_in_seconds || "0", 10))}`);
      lines.push("");

      if (errors.length > 0) {
        lines.push("## Partial Failures");
        lines.push("Some analyzers could not run (ACL restrictions or unsupported commands):");
        for (const e of errors) {
          lines.push(`- ${e}`);
        }
        lines.push("");
      }

      lines.push("## Summary");
      lines.push(`- Memory: ${memAnalysis.summary}`);
      lines.push(`- Slowlog: ${slowAnalysis?.summary ?? "unavailable (see errors above)"}`);
      lines.push(`- Clients: ${clientAnalysis?.summary ?? "unavailable (see errors above)"}`);
      lines.push(`- Keyspace: ${ksAnalysis.summary}`);
      if (latAnalysis) lines.push(`- Latency: ${latAnalysis.summary}`);
      lines.push(`- Replication: ${replAnalysis.summary}`);
      if (configAnalysis) {
        const cfgCritical = configAnalysis.findings.filter((f) => f.severity === "CRITICAL").length;
        const cfgWarnings = configAnalysis.findings.filter((f) => f.severity === "WARNING").length;
        const cfgSummary =
          cfgCritical > 0
            ? `CRITICAL: ${cfgCritical} critical config issue(s)`
            : cfgWarnings > 0
              ? `WARNING: ${cfgWarnings} config warning(s)`
              : "Config OK";
        lines.push(`- Config: ${cfgSummary}`);
      } else {
        lines.push(`- Config: unavailable (see errors above)`);
      }

      // Critical findings first
      const criticals = allFindings.filter((f) => f.severity === "CRITICAL");
      const cfgCriticals = cfgFindings.filter((f) => f.severity === "CRITICAL");
      if (criticals.length > 0 || cfgCriticals.length > 0) {
        lines.push("");
        lines.push("## Critical Issues");
        for (const f of criticals) {
          lines.push(`- **${f.title}**: ${f.recommendation}`);
        }
        for (const f of cfgCriticals) {
          lines.push(`- **${f.setting}**: ${f.recommendation}`);
        }
      }

      const warnings = allFindings.filter((f) => f.severity === "WARNING");
      const cfgWarnings = cfgFindings.filter((f) => f.severity === "WARNING");
      if (warnings.length > 0 || cfgWarnings.length > 0) {
        lines.push("");
        lines.push("## Warnings");
        for (const f of warnings) {
          lines.push(`- **${f.title}**: ${f.recommendation}`);
        }
        for (const f of cfgWarnings) {
          lines.push(`- **${f.setting}**: ${f.recommendation}`);
        }
      }

      lines.push("");
      lines.push("---");
      lines.push("");
      lines.push(formatMemoryAnalysis(memAnalysis));

      if (slowAnalysis) {
        lines.push("");
        lines.push("---");
        lines.push("");
        lines.push(formatSlowlogAnalysis(slowAnalysis));
      }

      if (clientAnalysis) {
        lines.push("");
        lines.push("---");
        lines.push("");
        lines.push(formatClientAnalysis(clientAnalysis));
      }

      lines.push("");
      lines.push("---");
      lines.push("");
      lines.push(formatKeyspaceAnalysis(ksAnalysis));

      if (latAnalysis) {
        lines.push("");
        lines.push("---");
        lines.push("");
        lines.push(formatLatencyAnalysis(latAnalysis));
      }

      lines.push("");
      lines.push("---");
      lines.push("");
      lines.push(formatReplicationAnalysis(replAnalysis));

      if (configAnalysis) {
        lines.push("");
        lines.push("---");
        lines.push("");
        lines.push(formatConfigAnalysis(configAnalysis));
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: wrapRedisError("analyzing performance", err),
          },
        ],
      };
    }
  }
);

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// --- Start server ---
function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "****";
    }
    return parsed.toString();
  } catch {
    // Fallback regex for non-standard URLs
    return url.replace(/:([^@:]+)@/, ":****@");
  }
}

async function main() {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  console.error("MCP Redis Diagnostics running on stdio");
  console.error(`Redis URL: ${sanitizeUrl(url)}`);

  // Test Redis connectivity early — warn on stderr if unreachable
  try {
    const client = await getRedis();
    await client.ping();
    console.error("Redis connection: OK");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const sanitized = msg.replace(/\/\/[^@]+@/g, "//****:****@");
    console.error(`WARNING: Redis connection failed: ${sanitized}`);
    console.error("Configure via REDIS_URL environment variable (e.g., redis://localhost:6379)");
    console.error("The server will start, but tools will return errors until Redis is reachable.");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Graceful shutdown
process.on("SIGINT", async () => {
  await closeRedis();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeRedis();
  process.exit(0);
});

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  const sanitized = msg.replace(/\/\/[^@]+@/g, "//****:****@");
  console.error("Fatal error:", sanitized);
  process.exit(1);
});
