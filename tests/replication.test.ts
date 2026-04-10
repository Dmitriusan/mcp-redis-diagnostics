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

  it("does NOT warn about inactive backlog when there are 0 replicas (expected state)", () => {
    // The backlog deactivates naturally when all replicas disconnect.
    // Firing a warning here is noise — the "0 replicas" WARNING covers this scenario.
    const info = makeInfo({ replication: { role: "master", connected_slaves: "0", repl_backlog_active: "0", repl_backlog_size: "0" } });
    const analysis = analyzeReplication(info);
    const backlogFinding = analysis.findings.find((f) => f.title.includes("backlog not active"));
    expect(backlogFinding).toBeUndefined();
  });

  it("warns about inactive backlog when replicas ARE connected (anomaly)", () => {
    // Replicas connected but backlog inactive is an anomalous configuration.
    const info = makeInfo({ replication: { role: "master", connected_slaves: "2", repl_backlog_active: "0", repl_backlog_size: "0" } });
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

describe("analyzeReplication — per-replica details", () => {
  function makeInfoWithReplicas(replicaLines: string): ReturnType<typeof parseRedisInfo> {
    const raw = `# Replication
role:master
connected_slaves:2
repl_backlog_active:1
repl_backlog_size:16777216
second_repl_offset:0
master_sync_in_progress:0
${replicaLines}

# Server
redis_version:7.2.4
`;
    return parseRedisInfo(raw);
  }

  it("detects replica in non-online state as CRITICAL", () => {
    const info = makeInfoWithReplicas(
      "slave0:ip=192.168.1.2,port=6380,state=wait_bgsave,offset=0,lag=0\n" +
      "slave1:ip=192.168.1.3,port=6381,state=online,offset=105,lag=0"
    );
    const analysis = analyzeReplication(info);
    const finding = analysis.findings.find((f) => f.title.includes("wait_bgsave"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("CRITICAL");
    expect(finding!.detail).toContain("192.168.1.2:6380");
  });

  it("detects replica with high lag as WARNING", () => {
    const info = makeInfoWithReplicas(
      "slave0:ip=10.0.0.5,port=6380,state=online,offset=1000,lag=30"
    );
    const analysis = analyzeReplication(info);
    const finding = analysis.findings.find((f) => f.title.includes("lag is 30s"));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
    expect(finding!.detail).toContain("stale data");
    expect(finding!.recommendation).toContain("repl-backlog-size");
  });

  it("does not flag replica with low lag", () => {
    const info = makeInfoWithReplicas(
      "slave0:ip=10.0.0.5,port=6380,state=online,offset=1000,lag=1"
    );
    const analysis = analyzeReplication(info);
    const lagFindings = analysis.findings.filter((f) => f.title.includes("lag is"));
    expect(lagFindings).toHaveLength(0);
  });

  it("populates replicas array correctly", () => {
    const info = makeInfoWithReplicas(
      "slave0:ip=192.168.1.2,port=6380,state=online,offset=100,lag=0\n" +
      "slave1:ip=192.168.1.3,port=6381,state=online,offset=98,lag=2"
    );
    const analysis = analyzeReplication(info);
    expect(analysis.replicas).toHaveLength(2);
    expect(analysis.replicas[0].ip).toBe("192.168.1.2");
    expect(analysis.replicas[0].state).toBe("online");
    expect(analysis.replicas[1].lag).toBe(2);
  });

  it("formatReplicationAnalysis shows replica table when replicas are present", () => {
    const info = makeInfoWithReplicas(
      "slave0:ip=10.0.0.5,port=6380,state=online,offset=500,lag=1"
    );
    const analysis = analyzeReplication(info);
    const output = formatReplicationAnalysis(analysis);
    expect(output).toContain("## Replica Details");
    expect(output).toContain("slave0");
    expect(output).toContain("10.0.0.5:6380");
    expect(output).toContain("online");
  });

  it("formatReplicationAnalysis omits replica table when no replicas", () => {
    const info = makeInfo({ replication: { role: "master", connected_slaves: "0", repl_backlog_active: "0", repl_backlog_size: "0" } });
    const analysis = analyzeReplication(info);
    const output = formatReplicationAnalysis(analysis);
    expect(output).not.toContain("## Replica Details");
  });
});
