import { describe, it, expect } from "vitest";
import {
  parseSlowlogEntries,
  analyzeSlowlog,
  formatSlowlogAnalysis,
} from "../src/analyzers/slowlog.js";

describe("parseSlowlogEntries", () => {
  it("parses Redis SLOWLOG GET format", () => {
    const raw = [
      [1, 1709000000, 15000, ["KEYS", "*"], "127.0.0.1:6379", "app1"],
      [2, 1709000001, 5000, ["GET", "user:123"], "127.0.0.1:6380", ""],
    ];
    const entries = parseSlowlogEntries(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(1);
    expect(entries[0].duration).toBe(15000);
    expect(entries[0].command).toEqual(["KEYS", "*"]);
    expect(entries[0].clientAddr).toBe("127.0.0.1:6379");
  });

  it("handles empty input", () => {
    expect(parseSlowlogEntries([])).toHaveLength(0);
  });

  it("handles non-array input", () => {
    expect(parseSlowlogEntries("not an array" as unknown as unknown[])).toHaveLength(0);
  });

  it("handles string IDs and durations", () => {
    const raw = [["5", "1709000000", "20000", ["SET", "key", "val"], "", ""]];
    const entries = parseSlowlogEntries(raw);
    expect(entries[0].id).toBe(5);
    expect(entries[0].duration).toBe(20000);
  });
});

describe("analyzeSlowlog", () => {
  it("detects KEYS command as CRITICAL", () => {
    const entries = parseSlowlogEntries([
      [1, 1709000000, 50000, ["KEYS", "*"], "", ""],
    ]);
    const analysis = analyzeSlowlog(entries);
    const keysFinding = analysis.findings.find((f) => f.title.includes("KEYS"));
    expect(keysFinding).toBeDefined();
    expect(keysFinding!.severity).toBe("CRITICAL");
    expect(keysFinding!.recommendation).toContain("SCAN");
  });

  it("detects SMEMBERS as WARNING", () => {
    const entries = parseSlowlogEntries([
      [1, 1709000000, 12000, ["SMEMBERS", "bigset"], "", ""],
    ]);
    const analysis = analyzeSlowlog(entries);
    const finding = analysis.findings.find((f) => f.title.includes("SMEMBERS"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
    expect(finding!.recommendation).toContain("SSCAN");
  });

  it("detects HGETALL as WARNING", () => {
    const entries = parseSlowlogEntries([
      [1, 1709000000, 12000, ["HGETALL", "bighash"], "", ""],
    ]);
    const analysis = analyzeSlowlog(entries);
    const finding = analysis.findings.find((f) => f.title.includes("HGETALL"));
    expect(finding).toBeDefined();
    expect(finding!.recommendation).toContain("HSCAN");
  });

  it("detects LRANGE as WARNING with bounded-range recommendation", () => {
    const entries = parseSlowlogEntries([
      [1, 1709000000, 18000, ["LRANGE", "mylist", "0", "-1"], "", ""],
    ]);
    const analysis = analyzeSlowlog(entries);
    const finding = analysis.findings.find((f) => f.title.includes("LRANGE"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
    expect(finding!.recommendation).toContain("LRANGE 0 -1");
  });

  it("detects extreme latency (>100ms) as CRITICAL", () => {
    const entries = parseSlowlogEntries([
      [1, 1709000000, 200000, ["SORT", "biglist"], "", ""],
    ]);
    const analysis = analyzeSlowlog(entries);
    const latencyFinding = analysis.findings.find((f) => f.title.includes("200.0ms"));
    expect(latencyFinding).toBeDefined();
    expect(latencyFinding!.severity).toBe("CRITICAL");
  });

  it("detects command concentration", () => {
    const raw = Array.from({ length: 10 }, (_, i) => [
      i,
      1709000000,
      12000,
      ["GET", `key:${i}`],
      "",
      "",
    ]);
    const entries = parseSlowlogEntries(raw);
    const analysis = analyzeSlowlog(entries);
    const concFinding = analysis.findings.find((f) => f.title.includes("dominates"));
    expect(concFinding).toBeDefined();
  });

  it("detects command concentration in small slowlog (2 entries)", () => {
    // Even with only 2 entries, if one command accounts for >50%, a warning should fire.
    // Previously missed: entries.length > 5 guard skipped slowlogs with ≤5 entries.
    const entries = parseSlowlogEntries([
      [1, 1709000000, 15000, ["SORT", "biglist"], "", ""],
      [2, 1709000001, 12000, ["SORT", "otherlist"], "", ""],
    ]);
    const analysis = analyzeSlowlog(entries);
    const concFinding = analysis.findings.find((f) => f.title.includes("dominates"));
    expect(concFinding).toBeDefined();
    expect(concFinding!.title).toContain("SORT");
    expect(concFinding!.title).toContain("100%");
  });

  it("detects FLUSHALL as CRITICAL", () => {
    const entries = parseSlowlogEntries([
      [1, 1709000000, 5000, ["FLUSHALL"], "", ""],
    ]);
    const analysis = analyzeSlowlog(entries);
    const finding = analysis.findings.find((f) => f.title.includes("FLUSHALL"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("CRITICAL");
  });

  it("detects FLUSHDB as CRITICAL", () => {
    const entries = parseSlowlogEntries([
      [1, 1709000000, 3000, ["FLUSHDB"], "", ""],
    ]);
    const analysis = analyzeSlowlog(entries);
    const finding = analysis.findings.find((f) => f.title.includes("FLUSHDB"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("CRITICAL");
  });

  it("detects SORT as WARNING with sorted-set recommendation", () => {
    const entries = parseSlowlogEntries([
      [1, 1709000000, 8000, ["SORT", "list:users"], "", ""],
    ]);
    const analysis = analyzeSlowlog(entries);
    const finding = analysis.findings.find((f) => f.title.includes("SORT"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
    expect(finding!.recommendation).toContain("sorted sets");
  });

  it("reports empty slowlog as healthy", () => {
    const analysis = analyzeSlowlog([]);
    expect(analysis.summary).toContain("clean");
    expect(analysis.totalEntries).toBe(0);
  });

  it("detects full slowlog buffer", () => {
    const raw = Array.from({ length: 128 }, (_, i) => [
      i,
      1709000000,
      12000,
      ["GET", `key:${i}`],
      "",
      "",
    ]);
    const entries = parseSlowlogEntries(raw);
    const analysis = analyzeSlowlog(entries);
    const bufferFinding = analysis.findings.find((f) => f.title.includes("buffer is full"));
    expect(bufferFinding).toBeDefined();
  });

  it("calculates command breakdown correctly", () => {
    const entries = parseSlowlogEntries([
      [1, 1709000000, 10000, ["GET", "a"], "", ""],
      [2, 1709000001, 20000, ["GET", "b"], "", ""],
      [3, 1709000002, 30000, ["SET", "c", "v"], "", ""],
    ]);
    const analysis = analyzeSlowlog(entries);
    expect(analysis.commandBreakdown.GET.count).toBe(2);
    expect(analysis.commandBreakdown.GET.totalDuration).toBe(30000);
    expect(analysis.commandBreakdown.GET.maxDuration).toBe(20000);
    expect(analysis.commandBreakdown.SET.count).toBe(1);
  });

  it("formatSlowlogAnalysis produces readable output", () => {
    const entries = parseSlowlogEntries([
      [1, 1709000000, 15000, ["GET", "key"], "", ""],
    ]);
    const analysis = analyzeSlowlog(entries);
    const output = formatSlowlogAnalysis(analysis);
    expect(output).toContain("# Redis Slowlog Analysis");
    expect(output).toContain("Command Breakdown");
    expect(output).toContain("GET");
  });
});
