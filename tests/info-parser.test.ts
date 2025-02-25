import { describe, it, expect } from "vitest";
import {
  parseRedisInfo,
  parseKeyspaceEntries,
  infoNum,
  infoStr,
  formatBytes,
} from "../src/parsers/info.js";

const SAMPLE_INFO = `# Server
redis_version:7.2.4
redis_mode:standalone
os:Linux 6.1.0-18-amd64 x86_64
uptime_in_seconds:86400
maxclients:10000

# Clients
connected_clients:42
blocked_clients:2

# Memory
used_memory:52428800
used_memory_human:50.00M
used_memory_rss:78643200
used_memory_peak:104857600
maxmemory:134217728
maxmemory_policy:allkeys-lru
mem_fragmentation_ratio:1.50

# Stats
keyspace_hits:950000
keyspace_misses:50000
evicted_keys:1234
expired_keys:56789
total_commands_processed:10000000

# Replication
role:master
connected_slaves:0

# CPU
used_cpu_sys:123.45
used_cpu_user:456.78

# Keyspace
db0:keys=150000,expires=120000,avg_ttl=3600000
db1:keys=5000,expires=5000,avg_ttl=1800000
`;

describe("parseRedisInfo", () => {
  it("parses all sections from INFO output", () => {
    const info = parseRedisInfo(SAMPLE_INFO);
    expect(info.server.redis_version).toBe("7.2.4");
    expect(info.clients.connected_clients).toBe("42");
    expect(info.memory.used_memory).toBe("52428800");
    expect(info.stats.keyspace_hits).toBe("950000");
    expect(info.replication.role).toBe("master");
    expect(info.cpu.used_cpu_sys).toBe("123.45");
  });

  it("parses keyspace entries", () => {
    const info = parseRedisInfo(SAMPLE_INFO);
    expect(info.keyspace.db0).toBe("keys=150000,expires=120000,avg_ttl=3600000");
    expect(info.keyspace.db1).toBe("keys=5000,expires=5000,avg_ttl=1800000");
  });

  it("handles empty input", () => {
    const info = parseRedisInfo("");
    expect(info.server).toEqual({});
    expect(info.memory).toEqual({});
  });

  it("handles malformed lines gracefully", () => {
    const info = parseRedisInfo("# Server\ngarbage line\nredis_version:7.0\n");
    expect(info.server.redis_version).toBe("7.0");
  });

  it("handles values with colons", () => {
    const info = parseRedisInfo("# Server\nredis_git_sha1:abc:def\n");
    expect(info.server.redis_git_sha1).toBe("abc:def");
  });
});

describe("parseKeyspaceEntries", () => {
  it("parses keyspace db entries", () => {
    const info = parseRedisInfo(SAMPLE_INFO);
    const entries = parseKeyspaceEntries(info);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      db: "db0",
      keys: 150000,
      expires: 120000,
      avgTtl: 3600000,
    });
    expect(entries[1]).toEqual({
      db: "db1",
      keys: 5000,
      expires: 5000,
      avgTtl: 1800000,
    });
  });

  it("returns empty for no keyspace", () => {
    const info = parseRedisInfo("# Keyspace\n");
    const entries = parseKeyspaceEntries(info);
    expect(entries).toHaveLength(0);
  });
});

describe("infoNum", () => {
  it("extracts numeric values", () => {
    const info = parseRedisInfo(SAMPLE_INFO);
    expect(infoNum(info, "memory", "used_memory")).toBe(52428800);
    expect(infoNum(info, "clients", "connected_clients")).toBe(42);
  });

  it("returns 0 for missing keys", () => {
    const info = parseRedisInfo(SAMPLE_INFO);
    expect(infoNum(info, "memory", "nonexistent")).toBe(0);
    expect(infoNum(info, "nosection", "nokey")).toBe(0);
  });
});

describe("infoStr", () => {
  it("extracts string values", () => {
    const info = parseRedisInfo(SAMPLE_INFO);
    expect(infoStr(info, "server", "redis_version")).toBe("7.2.4");
    expect(infoStr(info, "memory", "maxmemory_policy")).toBe("allkeys-lru");
  });

  it("returns empty string for missing keys", () => {
    const info = parseRedisInfo(SAMPLE_INFO);
    expect(infoStr(info, "server", "nonexistent")).toBe("");
  });
});

describe("formatBytes", () => {
  it("formats bytes correctly", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023.0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1048576)).toBe("1.0 MB");
    expect(formatBytes(1073741824)).toBe("1.0 GB");
  });
});
