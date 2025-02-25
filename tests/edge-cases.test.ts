import { describe, it, expect } from "vitest";
import { parseRedisInfo, parseKeyspaceEntries, infoNum } from "../src/parsers/info.js";
import { analyzeMemory } from "../src/analyzers/memory.js";
import { parseSlowlogEntries, analyzeSlowlog } from "../src/analyzers/slowlog.js";
import { parseClientList, analyzeClients } from "../src/analyzers/clients.js";
import { analyzeKeyspace } from "../src/analyzers/keyspace.js";

describe("edge cases - INFO parser", () => {
  it("handles completely empty string", () => {
    const info = parseRedisInfo("");
    expect(info.server).toEqual({});
    expect(info.memory).toEqual({});
    expect(infoNum(info, "memory", "used_memory")).toBe(0);
  });

  it("handles INFO with only some sections", () => {
    const info = parseRedisInfo(`# Server
redis_version:7.2.4

# Memory
used_memory:1000000
`);
    expect(info.server.redis_version).toBe("7.2.4");
    expect(info.memory.used_memory).toBe("1000000");
    expect(info.clients).toEqual({});
    expect(info.stats).toEqual({});
  });

  it("handles unknown sections gracefully", () => {
    const info = parseRedisInfo(`# CustomSection
custom_key:custom_value
`);
    expect(info["customsection"]?.custom_key).toBe("custom_value");
  });

  it("handles keyspace with no db entries", () => {
    const info = parseRedisInfo("# Keyspace\n");
    const entries = parseKeyspaceEntries(info);
    expect(entries).toHaveLength(0);
  });
});

describe("edge cases - memory analyzer", () => {
  it("handles zero fragmentation ratio", () => {
    const info = parseRedisInfo(`# Memory
used_memory:1000
used_memory_rss:1000
used_memory_peak:1000
maxmemory:0
maxmemory_policy:noeviction
mem_fragmentation_ratio:0

# Stats
evicted_keys:0
`);
    const analysis = analyzeMemory(info);
    // Should not crash, should report something meaningful
    expect(analysis.findings.length).toBeGreaterThan(0);
  });

  it("handles all zero memory values", () => {
    const info = parseRedisInfo(`# Memory
used_memory:0
used_memory_rss:0
used_memory_peak:0
maxmemory:0
maxmemory_policy:noeviction
mem_fragmentation_ratio:0

# Stats
evicted_keys:0
`);
    const analysis = analyzeMemory(info);
    expect(analysis.usedMemory).toBe(0);
  });
});

describe("edge cases - slowlog", () => {
  it("handles malformed slowlog entries", () => {
    const entries = parseSlowlogEntries([
      "not an array",
      null,
      undefined,
      42,
    ] as unknown[]);
    expect(entries).toHaveLength(4); // returns defaults for malformed
    expect(entries[0].duration).toBe(0);
  });

  it("handles slowlog entry with missing command array", () => {
    const entries = parseSlowlogEntries([[1, 1709000000, 5000, null, "", ""]]);
    expect(entries[0].command).toEqual([]);
    expect(entries[0].duration).toBe(5000);
  });

  it("handles single slowlog entry", () => {
    const entries = parseSlowlogEntries([[1, 1709000000, 5000, ["SET", "key", "val"], "", ""]]);
    const analysis = analyzeSlowlog(entries);
    expect(analysis.totalEntries).toBe(1);
    expect(analysis.commandBreakdown.SET).toBeDefined();
  });

  it("handles FLUSHDB as CRITICAL", () => {
    const entries = parseSlowlogEntries([[1, 1709000000, 5000, ["FLUSHDB"], "", ""]]);
    const analysis = analyzeSlowlog(entries);
    const finding = analysis.findings.find((f) => f.title.includes("FLUSHDB"));
    expect(finding?.severity).toBe("CRITICAL");
  });
});

describe("edge cases - clients", () => {
  it("handles empty CLIENT LIST", () => {
    const clients = parseClientList("");
    expect(clients).toHaveLength(0);
  });

  it("handles CLIENT LIST with whitespace only", () => {
    const clients = parseClientList("   \n\n   \n");
    expect(clients).toHaveLength(0);
  });

  it("handles client entry with minimal fields", () => {
    const clients = parseClientList("id=1 addr=127.0.0.1:5000");
    expect(clients).toHaveLength(1);
    expect(clients[0].id).toBe("1");
    expect(clients[0].idle).toBe(0); // defaults to 0
    expect(clients[0].flags).toBe("");
  });

  it("handles analyzeClients with zero maxclients", () => {
    const clients = parseClientList("id=1 addr=127.0.0.1:5000 fd=5 name=app age=10 idle=1 flags=N db=0 cmd=get qbuf=0 qbuf-free=32768 obl=0 oll=0 omem=0");
    const info = parseRedisInfo(`# Clients
connected_clients:1
blocked_clients:0

# Server
maxclients:0
`);
    // Should not crash with division by zero
    const analysis = analyzeClients(clients, info);
    expect(analysis.totalClients).toBe(1);
  });
});

describe("edge cases - keyspace", () => {
  it("handles keyspace with zero hits and zero misses", () => {
    const info = parseRedisInfo(`# Stats
keyspace_hits:0
keyspace_misses:0
expired_keys:0
evicted_keys:0

# Keyspace
db0:keys=100,expires=50,avg_ttl=1000
`);
    const analysis = analyzeKeyspace(info);
    expect(analysis.hitRate).toBe(0); // 0/0 should be 0, not NaN
  });

  it("handles single key in keyspace", () => {
    const info = parseRedisInfo(`# Stats
keyspace_hits:1
keyspace_misses:0
expired_keys:0
evicted_keys:0

# Keyspace
db0:keys=1,expires=0,avg_ttl=0
`);
    const analysis = analyzeKeyspace(info);
    expect(analysis.totalKeys).toBe(1);
    expect(analysis.ttlCoveragePct).toBe(0);
  });
});
