import { describe, it, expect } from "vitest";
import { parseRedisInfo } from "../src/parsers/info.js";
import { analyzeMemory, formatMemoryAnalysis } from "../src/analyzers/memory.js";

function makeInfo(overrides: Record<string, Record<string, string>> = {}) {
  const base = `# Memory
used_memory:${overrides.memory?.used_memory || "52428800"}
used_memory_rss:${overrides.memory?.used_memory_rss || "78643200"}
used_memory_peak:${overrides.memory?.used_memory_peak || "104857600"}
maxmemory:${overrides.memory?.maxmemory || "134217728"}
maxmemory_policy:${overrides.memory?.maxmemory_policy || "allkeys-lru"}
mem_fragmentation_ratio:${overrides.memory?.mem_fragmentation_ratio || "1.50"}

# Stats
evicted_keys:${overrides.stats?.evicted_keys || "0"}

# Server
redis_version:7.2.4
`;
  return parseRedisInfo(base);
}

describe("analyzeMemory", () => {
  it("detects high fragmentation", () => {
    const info = makeInfo({ memory: { mem_fragmentation_ratio: "3.5", used_memory: "1000000", used_memory_rss: "3500000", used_memory_peak: "1000000", maxmemory: "10000000", maxmemory_policy: "allkeys-lru" } });
    const analysis = analyzeMemory(info);
    const fragFinding = analysis.findings.find((f) => f.title.includes("fragmentation"));
    expect(fragFinding).toBeDefined();
    expect(fragFinding!.severity).toBe("CRITICAL");
    expect(fragFinding!.recommendation).toContain("activedefrag");
  });

  it("detects moderate fragmentation as WARNING", () => {
    const info = makeInfo({ memory: { mem_fragmentation_ratio: "2.0", used_memory: "1000000", used_memory_rss: "2000000", used_memory_peak: "1000000", maxmemory: "10000000", maxmemory_policy: "allkeys-lru" } });
    const analysis = analyzeMemory(info);
    const fragFinding = analysis.findings.find((f) => f.title.includes("fragmentation"));
    expect(fragFinding).toBeDefined();
    expect(fragFinding!.severity).toBe("WARNING");
  });

  it("detects swap risk (fragmentation < 1.0)", () => {
    const info = makeInfo({ memory: { mem_fragmentation_ratio: "0.8", used_memory: "1000000", used_memory_rss: "800000", used_memory_peak: "1000000", maxmemory: "10000000", maxmemory_policy: "allkeys-lru" } });
    const analysis = analyzeMemory(info);
    const swapFinding = analysis.findings.find((f) => f.title.includes("below 1.0"));
    expect(swapFinding).toBeDefined();
    expect(swapFinding!.recommendation).toContain("Swapping");
  });

  it("detects maxmemory pressure >90%", () => {
    const info = makeInfo({ memory: { used_memory: "95000000", maxmemory: "100000000", maxmemory_policy: "noeviction", mem_fragmentation_ratio: "1.1", used_memory_rss: "100000000", used_memory_peak: "95000000" } });
    const analysis = analyzeMemory(info);
    const pressureFinding = analysis.findings.find((f) => f.title.includes("90") || f.title.includes("95"));
    expect(pressureFinding).toBeDefined();
    expect(pressureFinding!.severity).toBe("CRITICAL");
  });

  it("warns about no maxmemory limit", () => {
    const info = makeInfo({ memory: { maxmemory: "0", mem_fragmentation_ratio: "1.1", used_memory: "1000000", used_memory_rss: "1100000", used_memory_peak: "1000000", maxmemory_policy: "noeviction" } });
    const analysis = analyzeMemory(info);
    const noLimit = analysis.findings.find((f) => f.title.includes("No maxmemory"));
    expect(noLimit).toBeDefined();
  });

  it("detects high eviction count", () => {
    const info = makeInfo({ stats: { evicted_keys: "50000" } });
    const analysis = analyzeMemory(info);
    const eviction = analysis.findings.find((f) => f.title.includes("evicted"));
    expect(eviction).toBeDefined();
    expect(eviction!.severity).toBe("WARNING");
  });

  it("warns about noeviction policy", () => {
    const info = makeInfo({ memory: { maxmemory_policy: "noeviction", maxmemory: "100000000", used_memory: "10000000", used_memory_rss: "11000000", used_memory_peak: "10000000", mem_fragmentation_ratio: "1.1" } });
    const analysis = analyzeMemory(info);
    const noevict = analysis.findings.find((f) => f.title.includes("noeviction"));
    expect(noevict).toBeDefined();
  });

  it("suppresses standalone noeviction warning when memory is already at >90% CRITICAL", () => {
    // At >90% with noeviction, the CRITICAL finding already contains noeviction guidance.
    // A separate noeviction WARNING would be redundant.
    const info = makeInfo({
      memory: {
        used_memory: "95000000",
        maxmemory: "100000000",
        maxmemory_policy: "noeviction",
        mem_fragmentation_ratio: "1.1",
        used_memory_rss: "100000000",
        used_memory_peak: "95000000",
      },
    });
    const analysis = analyzeMemory(info);
    const noevictFindings = analysis.findings.filter((f) => f.title === "Using noeviction policy");
    expect(noevictFindings).toHaveLength(0);
  });

  it("shows noeviction warning when memory pressure is low", () => {
    // At low memory usage, noeviction policy is still a risk worth calling out.
    const info = makeInfo({
      memory: {
        used_memory: "10000000",
        maxmemory: "100000000",
        maxmemory_policy: "noeviction",
        mem_fragmentation_ratio: "1.1",
        used_memory_rss: "11000000",
        used_memory_peak: "10000000",
      },
    });
    const analysis = analyzeMemory(info);
    const noevictFinding = analysis.findings.find((f) => f.title === "Using noeviction policy");
    expect(noevictFinding).toBeDefined();
    expect(noevictFinding!.severity).toBe("WARNING");
  });

  it("reports INFO when peak memory was more than 2x current", () => {
    const info = makeInfo({
      memory: {
        used_memory: "50000000",
        used_memory_peak: "200000000",
        used_memory_rss: "55000000",
        maxmemory: "500000000",
        maxmemory_policy: "allkeys-lru",
        mem_fragmentation_ratio: "1.1",
      },
    });
    const analysis = analyzeMemory(info);
    const peakFinding = analysis.findings.find((f) => f.title.includes("Peak memory was"));
    expect(peakFinding).toBeDefined();
    expect(peakFinding!.severity).toBe("INFO");
    expect(peakFinding!.title).toContain("4.0x");
    expect(peakFinding!.recommendation).toContain("spike");
  });

  it("does not flag peak memory when ratio is below 2x", () => {
    const info = makeInfo({
      memory: {
        used_memory: "80000000",
        used_memory_peak: "100000000",
        used_memory_rss: "88000000",
        maxmemory: "500000000",
        maxmemory_policy: "allkeys-lru",
        mem_fragmentation_ratio: "1.1",
      },
    });
    const analysis = analyzeMemory(info);
    const peakFinding = analysis.findings.find((f) => f.title.includes("Peak memory was"));
    expect(peakFinding).toBeUndefined();
  });

  it("reports healthy memory", () => {
    const info = makeInfo({ memory: { mem_fragmentation_ratio: "1.1", used_memory: "10000000", used_memory_rss: "11000000", used_memory_peak: "10000000", maxmemory: "100000000", maxmemory_policy: "allkeys-lru" } });
    const analysis = analyzeMemory(info);
    expect(analysis.summary).toContain("OK");
  });

  it("formatMemoryAnalysis produces readable output", () => {
    const info = makeInfo();
    const analysis = analyzeMemory(info);
    const output = formatMemoryAnalysis(analysis);
    expect(output).toContain("# Redis Memory Analysis");
    expect(output).toContain("Used Memory:");
    expect(output).toContain("Fragmentation Ratio:");
  });
});
