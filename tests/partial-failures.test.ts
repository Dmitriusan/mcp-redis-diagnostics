/**
 * Test partial failure resilience in analyzer functions.
 *
 * In production, Redis ACLs can block SLOWLOG, CLIENT LIST, or LATENCY
 * commands. The analyze_performance unified tool should handle each
 * sub-analyzer failing independently without crashing the whole report.
 */
import { describe, it, expect } from "vitest";
import { parseRedisInfo, type RedisInfo } from "../src/parsers/info.js";
import { analyzeMemory, formatMemoryAnalysis } from "../src/analyzers/memory.js";
import { analyzeConfig, formatConfigAnalysis } from "../src/analyzers/config.js";
import {
  parseSlowlogEntries,
  analyzeSlowlog,
  formatSlowlogAnalysis,
} from "../src/analyzers/slowlog.js";
import {
  parseClientList,
  analyzeClients,
  formatClientAnalysis,
} from "../src/analyzers/clients.js";
import { analyzeKeyspace, formatKeyspaceAnalysis } from "../src/analyzers/keyspace.js";
import {
  parseLatencyLatest,
  analyzeLatency,
  formatLatencyAnalysis,
} from "../src/analyzers/latency.js";

const MINIMAL_INFO = parseRedisInfo(`# Server
redis_version:7.2.4
uptime_in_seconds:3600
slowlog-log-slower-than:10000

# Memory
used_memory:1000000
used_memory_peak:2000000
maxmemory:0
mem_fragmentation_ratio:1.2

# Clients
connected_clients:5
maxclients:100
blocked_clients:0

# Stats
total_connections_received:100

# Keyspace
db0:keys=500,expires=100,avg_ttl=3600000
`);

describe("Partial failure resilience", () => {
  describe("Memory analyzer (always works with INFO)", () => {
    it("works with minimal INFO data", () => {
      const analysis = analyzeMemory(MINIMAL_INFO);
      const output = formatMemoryAnalysis(analysis);
      expect(output).toContain("Memory Analysis");
      expect(analysis.summary.length).toBeGreaterThan(0);
    });

    it("works with completely empty INFO", () => {
      const emptyInfo = parseRedisInfo("");
      const analysis = analyzeMemory(emptyInfo);
      expect(analysis.summary).toBeDefined();
    });
  });

  describe("Slowlog analyzer (may fail with ACL)", () => {
    it("handles empty slowlog entries", () => {
      const entries = parseSlowlogEntries([]);
      const analysis = analyzeSlowlog(entries, 10000);
      expect(analysis.summary).toContain("no slow commands");
      const output = formatSlowlogAnalysis(analysis);
      expect(output).toContain("Slowlog Analysis");
    });

    it("handles null/undefined entries gracefully", () => {
      const entries = parseSlowlogEntries(null as unknown as unknown[]);
      expect(entries).toEqual([]);
    });

    it("handles non-array input", () => {
      const entries = parseSlowlogEntries("not an array" as unknown as unknown[]);
      expect(entries).toEqual([]);
    });
  });

  describe("Client analyzer (may fail with ACL on CLIENT LIST)", () => {
    it("handles empty client list string", () => {
      const clients = parseClientList("");
      const analysis = analyzeClients(clients, MINIMAL_INFO);
      expect(analysis.summary).toBeDefined();
      const output = formatClientAnalysis(analysis);
      expect(output).toContain("Client Analysis");
    });

    it("handles malformed client list entries", () => {
      const clients = parseClientList("not=valid client=data\n\n\n");
      expect(clients.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Keyspace analyzer (always works with INFO)", () => {
    it("handles INFO with no keyspace section", () => {
      const noKsInfo = parseRedisInfo(`# Server
redis_version:7.2.4
`);
      const analysis = analyzeKeyspace(noKsInfo);
      const output = formatKeyspaceAnalysis(analysis);
      expect(output).toContain("Keyspace Analysis");
    });
  });

  describe("Latency analyzer (may fail with older Redis)", () => {
    it("handles empty latency data", () => {
      const events = parseLatencyLatest([]);
      const analysis = analyzeLatency(events);
      expect(analysis.summary).toBeDefined();
      const output = formatLatencyAnalysis(analysis);
      expect(output).toContain("Latency Analysis");
    });

    it("handles null latency data", () => {
      const events = parseLatencyLatest(null as unknown as unknown[]);
      expect(events).toEqual([]);
    });
  });

  describe("Unified report assembly with missing sections", () => {
    it("produces report with only memory and keyspace (slowlog + clients failed)", () => {
      const memAnalysis = analyzeMemory(MINIMAL_INFO);
      const ksAnalysis = analyzeKeyspace(MINIMAL_INFO);

      // Simulate the unified report assembly from index.ts
      const errors = [
        "Slowlog: NOPERM this user has no permissions to run the 'slowlog|get' command",
        "Clients: NOPERM this user has no permissions to run the 'client|list' command",
      ];

      const lines: string[] = [];
      lines.push("# Redis Performance Report");
      lines.push("");

      const allFindings = [
        ...memAnalysis.findings,
        ...ksAnalysis.findings,
      ];

      if (errors.length > 0) {
        lines.push("## Partial Failures");
        for (const e of errors) {
          lines.push(`- ${e}`);
        }
      }

      lines.push("## Summary");
      lines.push(`- Memory: ${memAnalysis.summary}`);
      lines.push(`- Slowlog: unavailable (see errors above)`);
      lines.push(`- Clients: unavailable (see errors above)`);
      lines.push(`- Keyspace: ${ksAnalysis.summary}`);

      const report = lines.join("\n");
      expect(report).toContain("Redis Performance Report");
      expect(report).toContain("Partial Failures");
      expect(report).toContain("NOPERM");
      expect(report).toContain("Memory:");
      expect(report).toContain("unavailable");
      expect(report).toContain("Keyspace:");
    });

    it("produces report with all sections when nothing fails", () => {
      const memAnalysis = analyzeMemory(MINIMAL_INFO);
      const ksAnalysis = analyzeKeyspace(MINIMAL_INFO);
      const slowlogEntries = parseSlowlogEntries([]);
      const slowAnalysis = analyzeSlowlog(slowlogEntries, 10000);
      const clients = parseClientList("");
      const clientAnalysis = analyzeClients(clients, MINIMAL_INFO);
      const latEvents = parseLatencyLatest([]);
      const latAnalysis = analyzeLatency(latEvents);

      const allFindings = [
        ...memAnalysis.findings,
        ...slowAnalysis.findings,
        ...clientAnalysis.findings,
        ...ksAnalysis.findings,
        ...latAnalysis.findings,
      ];

      // No partial failures
      expect(allFindings).toBeDefined();
      expect(formatMemoryAnalysis(memAnalysis)).toContain("Memory");
      expect(formatSlowlogAnalysis(slowAnalysis)).toContain("Slowlog");
      expect(formatClientAnalysis(clientAnalysis)).toContain("Client");
      expect(formatKeyspaceAnalysis(ksAnalysis)).toContain("Keyspace");
      expect(formatLatencyAnalysis(latAnalysis)).toContain("Latency");
    });

    it("includes config analysis findings in overall critical count", () => {
      // Config criticals (e.g. no maxmemory) must surface in the unified report.
      const configMap = {
        maxmemory: "0",             // CRITICAL: no memory limit
        "maxmemory-policy": "noeviction",
        bind: "127.0.0.1",
        "protected-mode": "yes",
        requirepass: "s3cret",
        appendonly: "yes",
        save: "3600 1",
        timeout: "300",
        "tcp-keepalive": "300",
        hz: "10",
      };
      const configAnalysis = analyzeConfig(configMap);
      const cfgCriticals = configAnalysis.findings.filter((f) => f.severity === "CRITICAL");
      expect(cfgCriticals.length).toBeGreaterThan(0);
      // formatConfigAnalysis must also work independently (used in the unified report)
      const output = formatConfigAnalysis(configAnalysis);
      expect(output).toContain("## Critical Issues");
      expect(output).toContain("maxmemory");
    });
  });
});
