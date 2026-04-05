import { describe, it, expect } from "vitest";
import { parseRedisInfo } from "../src/parsers/info.js";
import { analyzeKeyspace, formatKeyspaceAnalysis } from "../src/analyzers/keyspace.js";

function makeInfo(overrides: {
  keyspace?: string;
  hits?: string;
  misses?: string;
  expired?: string;
  evicted?: string;
} = {}) {
  const base = `# Stats
keyspace_hits:${overrides.hits || "950000"}
keyspace_misses:${overrides.misses || "50000"}
expired_keys:${overrides.expired || "1000"}
evicted_keys:${overrides.evicted || "0"}

# Keyspace
${overrides.keyspace || "db0:keys=150000,expires=120000,avg_ttl=3600000"}
`;
  return parseRedisInfo(base);
}

describe("analyzeKeyspace", () => {
  it("calculates TTL coverage", () => {
    const info = makeInfo();
    const analysis = analyzeKeyspace(info);
    expect(analysis.totalKeys).toBe(150000);
    expect(analysis.totalExpires).toBe(120000);
    expect(analysis.ttlCoveragePct).toBe(80);
  });

  it("detects low TTL coverage", () => {
    const info = makeInfo({ keyspace: "db0:keys=100000,expires=5000,avg_ttl=1000" });
    const analysis = analyzeKeyspace(info);
    const ttlFinding = analysis.findings.find((f) => f.title.includes("TTL coverage"));
    expect(ttlFinding).toBeDefined();
    expect(ttlFinding!.severity).toBe("WARNING");
  });

  it("calculates cache hit rate", () => {
    const info = makeInfo({ hits: "900", misses: "100" });
    const analysis = analyzeKeyspace(info);
    expect(analysis.hitRate).toBe(90);
  });

  it("detects low hit rate <80%", () => {
    const info = makeInfo({ hits: "600", misses: "400" });
    const analysis = analyzeKeyspace(info);
    const hitFinding = analysis.findings.find((f) => f.title.includes("hit rate"));
    expect(hitFinding).toBeDefined();
    expect(hitFinding!.severity).toBe("WARNING");
  });

  it("detects critical low hit rate <50%", () => {
    const info = makeInfo({ hits: "300", misses: "700" });
    const analysis = analyzeKeyspace(info);
    const hitFinding = analysis.findings.find((f) => f.title.includes("hit rate"));
    expect(hitFinding).toBeDefined();
    expect(hitFinding!.severity).toBe("CRITICAL");
  });

  it("detects multiple databases", () => {
    const info = makeInfo({
      keyspace:
        "db0:keys=100,expires=50,avg_ttl=1000\ndb1:keys=200,expires=100,avg_ttl=2000\ndb2:keys=300,expires=150,avg_ttl=3000\ndb3:keys=400,expires=200,avg_ttl=4000",
    });
    const analysis = analyzeKeyspace(info);
    const dbFinding = analysis.findings.find((f) => f.title.includes("databases in use"));
    expect(dbFinding).toBeDefined();
    expect(analysis.databases).toHaveLength(4);
  });

  it("handles empty keyspace", () => {
    // Build info with no keyspace entries at all
    const info = parseRedisInfo(`# Stats
keyspace_hits:100
keyspace_misses:50
expired_keys:0
evicted_keys:0

# Keyspace
`);
    const analysis = analyzeKeyspace(info);
    expect(analysis.totalKeys).toBe(0);
    const emptyFinding = analysis.findings.find((f) => f.title.includes("empty"));
    expect(emptyFinding).toBeDefined();
  });

  it("reports healthy keyspace", () => {
    const info = makeInfo({ hits: "9500", misses: "500" });
    const analysis = analyzeKeyspace(info);
    expect(analysis.summary).toContain("OK");
  });

  it("formatKeyspaceAnalysis produces readable output", () => {
    const info = makeInfo();
    const analysis = analyzeKeyspace(info);
    const output = formatKeyspaceAnalysis(analysis);
    expect(output).toContain("# Redis Keyspace Analysis");
    expect(output).toContain("Total Keys:");
    expect(output).toContain("Cache Hit Rate:");
    expect(output).toContain("Database Distribution");
  });

  it("reports INFO for high expired key count", () => {
    const info = makeInfo({ expired: "2000000" });
    const analysis = analyzeKeyspace(info);
    const expiredFinding = analysis.findings.find((f) => f.title.includes("expired since start"));
    expect(expiredFinding).toBeDefined();
    expect(expiredFinding!.severity).toBe("INFO");
    expect(expiredFinding!.detail).toContain("active TTL-based cache management");
    expect(expiredFinding!.recommendation).toContain("expired_stale_perc");
  });

  it("does not flag expired key count below threshold", () => {
    const info = makeInfo({ expired: "500000" });
    const analysis = analyzeKeyspace(info);
    const expiredFinding = analysis.findings.find((f) => f.title.includes("expired since start"));
    expect(expiredFinding).toBeUndefined();
  });

  it("detects unbalanced distribution", () => {
    const info = makeInfo({
      keyspace: "db0:keys=100000,expires=50000,avg_ttl=1000\ndb1:keys=10,expires=5,avg_ttl=500",
    });
    const analysis = analyzeKeyspace(info);
    const unbalanced = analysis.findings.find((f) => f.title.includes("unbalanced"));
    expect(unbalanced).toBeDefined();
  });
});
