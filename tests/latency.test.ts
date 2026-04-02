import { describe, it, expect } from "vitest";
import {
  parseLatencyLatest,
  parseLatencyHistory,
  analyzeLatency,
  formatLatencyAnalysis,
} from "../src/analyzers/latency.js";

describe("parseLatencyLatest", () => {
  it("parses LATENCY LATEST output", () => {
    const raw = [
      ["command", 1709000000, 15, 200],
      ["fork", 1709000001, 50, 800],
    ];
    const events = parseLatencyLatest(raw);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      event: "command",
      timestamp: 1709000000,
      latencyMs: 15,
      maxLatencyMs: 200,
    });
    expect(events[1].event).toBe("fork");
    expect(events[1].maxLatencyMs).toBe(800);
  });

  it("handles empty input", () => {
    expect(parseLatencyLatest([])).toHaveLength(0);
  });

  it("handles non-array input", () => {
    expect(parseLatencyLatest("not array" as unknown as unknown[])).toHaveLength(0);
  });

  it("handles string values", () => {
    const raw = [["command", "1709000000", "10", "50"]];
    const events = parseLatencyLatest(raw);
    expect(events[0].timestamp).toBe(1709000000);
    expect(events[0].latencyMs).toBe(10);
  });
});

describe("parseLatencyHistory", () => {
  it("parses LATENCY HISTORY output", () => {
    const raw = [
      [1709000000, 15],
      [1709000010, 20],
      [1709000020, 25],
    ];
    const entries = parseLatencyHistory(raw);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ timestamp: 1709000000, latencyMs: 15 });
    expect(entries[2].latencyMs).toBe(25);
  });

  it("handles empty input", () => {
    expect(parseLatencyHistory([])).toHaveLength(0);
  });
});

describe("analyzeLatency", () => {
  it("reports no events when empty", () => {
    const analysis = analyzeLatency([]);
    expect(analysis.summary).toContain("No latency events");
    expect(analysis.findings[0].recommendation).toContain("latency-monitor-threshold");
  });

  it("detects critical fork latency >500ms", () => {
    const events = parseLatencyLatest([["fork", 1709000000, 600, 800]]);
    const analysis = analyzeLatency(events);
    const finding = analysis.findings.find((f) => f.title.includes("Fork latency spike"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("CRITICAL");
    expect(finding!.recommendation).toContain("replica");
  });

  it("detects warning fork latency >100ms", () => {
    const events = parseLatencyLatest([["fork", 1709000000, 120, 150]]);
    const analysis = analyzeLatency(events);
    const finding = analysis.findings.find((f) => f.title.includes("Fork latency"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
  });

  it("detects critical AOF latency >200ms", () => {
    const events = parseLatencyLatest([["aof-fsync-always", 1709000000, 250, 300]]);
    const analysis = analyzeLatency(events);
    const finding = analysis.findings.find((f) => f.title.includes("AOF latency spike"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("CRITICAL");
    expect(finding!.recommendation).toContain("SSD");
  });

  it("detects AOF warning >50ms", () => {
    const events = parseLatencyLatest([["aof-write", 1709000000, 60, 80]]);
    const analysis = analyzeLatency(events);
    const finding = analysis.findings.find((f) => f.title.includes("AOF latency"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
  });

  it("detects slow command latency >100ms", () => {
    const events = parseLatencyLatest([["command", 1709000000, 50, 150]]);
    const analysis = analyzeLatency(events);
    const finding = analysis.findings.find((f) => f.title.includes("Slow command"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
  });

  it("detects critical fast-command latency with THP recommendation", () => {
    const events = parseLatencyLatest([["fast-command", 1709000000, 200, 600]]);
    const analysis = analyzeLatency(events);
    const finding = analysis.findings.find((f) => f.severity === "CRITICAL");
    expect(finding).toBeDefined();
    expect(finding!.recommendation).toContain("transparent huge pages");
  });

  it("detects eviction cycle latency", () => {
    const events = parseLatencyLatest([["eviction-cycle", 1709000000, 120, 150]]);
    const analysis = analyzeLatency(events);
    const finding = analysis.findings.find((f) => f.title.includes("eviction"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
  });

  it("detects expire cycle latency with jitter recommendation", () => {
    const events = parseLatencyLatest([["expire-cycle", 1709000000, 110, 200]]);
    const analysis = analyzeLatency(events);
    const finding = analysis.findings.find((f) => f.title.includes("expiration"));
    expect(finding).toBeDefined();
    expect(finding!.recommendation).toContain("jitter");
  });

  it("detects increasing latency trend in history", () => {
    const events = parseLatencyLatest([["command", 1709000000, 50, 80]]);
    const history = {
      command: [
        { timestamp: 1709000000, latencyMs: 10 },
        { timestamp: 1709000010, latencyMs: 30 },
        { timestamp: 1709000020, latencyMs: 50 },
      ],
    };
    const analysis = analyzeLatency(events, history);
    const trendFinding = analysis.findings.find((f) => f.title.includes("Increasing"));
    expect(trendFinding).toBeDefined();
  });

  it("detects active-defrag-cycle latency", () => {
    const events = parseLatencyLatest([["active-defrag-cycle", 1709000000, 80, 150]]);
    const analysis = analyzeLatency(events);
    const finding = analysis.findings.find((f) => f.title.includes("Active defrag latency"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
    expect(finding!.recommendation).toContain("active-defrag-cycle-max-cpu-percent");
  });

  it("does not fire active-defrag-cycle warning below threshold", () => {
    const events = parseLatencyLatest([["active-defrag-cycle", 1709000000, 30, 80]]);
    const analysis = analyzeLatency(events);
    const finding = analysis.findings.find((f) => f.title.includes("Active defrag"));
    expect(finding).toBeUndefined();
  });

  it("detects generic unrecognized event above 200ms", () => {
    const events = parseLatencyLatest([["rdb-unlink-temp-file", 1709000000, 100, 300]]);
    const analysis = analyzeLatency(events);
    const finding = analysis.findings.find((f) => f.title.includes("300ms max"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
    expect(finding!.recommendation).toContain("system resources");
  });

  it("does not fire generic event warning below 200ms threshold", () => {
    const events = parseLatencyLatest([["rdb-unlink-temp-file", 1709000000, 50, 150]]);
    const analysis = analyzeLatency(events);
    // Should produce a healthy INFO finding, not a warning for this unknown event
    const warnFindings = analysis.findings.filter((f) => f.severity === "WARNING" || f.severity === "CRITICAL");
    expect(warnFindings).toHaveLength(0);
  });

  it("reports healthy when events within normal range", () => {
    const events = parseLatencyLatest([
      ["command", 1709000000, 5, 20],
      ["fork", 1709000001, 10, 50],
    ]);
    const analysis = analyzeLatency(events);
    expect(analysis.summary).toContain("OK");
  });

  it("formatLatencyAnalysis produces readable output", () => {
    const events = parseLatencyLatest([
      ["fork", 1709000000, 100, 600],
      ["command", 1709000001, 10, 30],
    ]);
    const analysis = analyzeLatency(events);
    const output = formatLatencyAnalysis(analysis);
    expect(output).toContain("# Redis Latency Analysis");
    expect(output).toContain("Latest Events");
    expect(output).toContain("fork");
  });
});
