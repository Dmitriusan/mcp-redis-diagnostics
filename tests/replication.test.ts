import { describe, it, expect } from "vitest";
import { parseRedisInfo } from "../src/parsers/info.js";
import { analyzeReplication, formatReplicationAnalysis } from "../src/analyzers/replication.js";

function makeInfo(overrides: Record<string, Record<string, string>> = {}) {
  const base = `# Replication
role:${overrides.replication?.role || "master"}
connected_slaves:${overrides.replication?.connected_slaves || "2"}
master_link_status:${overrides.replication?.master_link_status || ""}
master_last_io_seconds_ago:${overrides.replication?.master_last_io_seconds_ago || "0"}
repl_backlog_active:${overrides.replication?.repl_backlog_active || "1"}
repl_backlog_size:${overrides.replication?.repl_backlog_size || "16777216"}
second_repl_offset:${overrides.replication?.second_repl_offset || "0"}
master_sync_in_progress:${overrides.replication?.master_sync_in_progress || "0"}

# Server
redis_version:7.2.4
`;
  return parseRedisInfo(base);
}

describe("analyzeReplication", () => {
  it("detects master with 0 replicas", () => {
    const info = makeInfo({ replication: { role: "master", connected_slaves: "0", repl_backlog_active: "1", repl_backlog_size: "16777216" } });
    const analysis = analyzeReplication(info);
    const finding = analysis.findings.find((f) => f.title.includes("0 connected replicas"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
  });

  it("reports healthy master with replicas", () => {
    const info = makeInfo({ replication: { role: "master", connected_slaves: "2", repl_backlog_active: "1", repl_backlog_size: "16777216" } });
    const analysis = analyzeReplication(info);
    const finding = analysis.findings.find((f) => f.title.includes("2 connected replica(s)"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("INFO");
    expect(analysis.summary).toContain("OK");
  });

  it("detects broken master link on replica", () => {
    const info = makeInfo({ replication: { role: "slave", master_link_status: "down", master_last_io_seconds_ago: "0" } });
    const analysis = analyzeReplication(info);
    const finding = analysis.findings.find((f) => f.title.includes("Master link status: down"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("CRITICAL");
  });

  it("reports healthy replica link", () => {
    const info = makeInfo({ replication: { role: "slave", master_link_status: "up", master_last_io_seconds_ago: "1" } });
    const analysis = analyzeReplication(info);
    const finding = analysis.findings.find((f) => f.title.includes("Master link status: up"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("INFO");
  });

  it("detects high replication lag", () => {
    const info = makeInfo({ replication: { role: "slave", master_link_status: "up", master_last_io_seconds_ago: "30" } });
    const analysis = analyzeReplication(info);
    const finding = analysis.findings.find((f) => f.title.includes("High replication lag"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
    expect(finding!.detail).toContain("30 seconds");
  });

  it("detects small replication backlog on master", () => {
    const info = makeInfo({ replication: { role: "master", connected_slaves: "1", repl_backlog_active: "1", repl_backlog_size: "524288" } });
    const analysis = analyzeReplication(info);
    const finding = analysis.findings.find((f) => f.title.includes("backlog too small"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
    expect(finding!.recommendation).toContain("repl-backlog-size");
  });

  it("detects inactive backlog on master", () => {
    const info = makeInfo({ replication: { role: "master", connected_slaves: "0", repl_backlog_active: "0", repl_backlog_size: "0" } });
    const analysis = analyzeReplication(info);
    const finding = analysis.findings.find((f) => f.title.includes("backlog not active"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
  });

  it("detects sync in progress on replica", () => {
    const info = makeInfo({ replication: { role: "slave", master_link_status: "up", master_last_io_seconds_ago: "0", master_sync_in_progress: "1" } });
    const analysis = analyzeReplication(info);
    const finding = analysis.findings.find((f) => f.title.includes("Full synchronization"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
  });

  it("detects second_repl_offset on master", () => {
    const info = makeInfo({ replication: { role: "master", connected_slaves: "1", repl_backlog_active: "1", repl_backlog_size: "16777216", second_repl_offset: "12345" } });
    const analysis = analyzeReplication(info);
    const finding = analysis.findings.find((f) => f.title.includes("Partial resync offset"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("INFO");
  });

  it("formatReplicationAnalysis produces readable output for master", () => {
    const info = makeInfo({ replication: { role: "master", connected_slaves: "2", repl_backlog_active: "1", repl_backlog_size: "16777216" } });
    const analysis = analyzeReplication(info);
    const output = formatReplicationAnalysis(analysis);
    expect(output).toContain("# Redis Replication Analysis");
    expect(output).toContain("Role: master");
    expect(output).toContain("Connected Replicas: 2");
    expect(output).toContain("Backlog Active: yes");
  });

  it("formatReplicationAnalysis produces readable output for replica", () => {
    const info = makeInfo({ replication: { role: "slave", master_link_status: "up", master_last_io_seconds_ago: "2" } });
    const analysis = analyzeReplication(info);
    const output = formatReplicationAnalysis(analysis);
    expect(output).toContain("# Redis Replication Analysis");
    expect(output).toContain("Role: slave");
    expect(output).toContain("Master Link Status: up");
    expect(output).toContain("Last Master I/O: 2s ago");
  });
});
