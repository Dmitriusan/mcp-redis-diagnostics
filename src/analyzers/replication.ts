/**
 * Redis replication analyzer.
 * Detects replication health issues: link status, lag, backlog size, and sync failures.
 */

import { type RedisInfo, infoNum, infoStr, formatBytes } from "../parsers/info.js";

export interface ReplicationFinding {
  severity: "CRITICAL" | "WARNING" | "INFO";
  title: string;
  detail: string;
  recommendation: string;
}

export interface ReplicationAnalysis {
  role: string;
  connectedSlaves: number;
  masterLinkStatus: string;
  masterLastIoSecondsAgo: number;
  replBacklogActive: boolean;
  replBacklogSize: number;
  secondReplOffset: number;
  masterSyncInProgress: boolean;
  findings: ReplicationFinding[];
  summary: string;
}

export function analyzeReplication(info: RedisInfo): ReplicationAnalysis {
  const role = infoStr(info, "replication", "role") || "unknown";
  const connectedSlaves = infoNum(info, "replication", "connected_slaves");
  const masterLinkStatus = infoStr(info, "replication", "master_link_status");
  const masterLastIoSecondsAgo = infoNum(info, "replication", "master_last_io_seconds_ago");
  const replBacklogActive = infoNum(info, "replication", "repl_backlog_active") === 1;
  const replBacklogSize = infoNum(info, "replication", "repl_backlog_size");
  const secondReplOffset = infoNum(info, "replication", "second_repl_offset");
  const masterSyncInProgress = infoNum(info, "replication", "master_sync_in_progress") === 1;

  const findings: ReplicationFinding[] = [];

  if (role === "master") {
    // Master with no connected replicas
    if (connectedSlaves === 0) {
      findings.push({
        severity: "WARNING",
        title: "Master with 0 connected replicas",
        detail: "This master has no connected replicas. If this is expected (standalone deployment), this is informational.",
        recommendation: "If replicas are expected, check replica connectivity and logs. For high availability, configure at least one replica.",
      });
    } else {
      findings.push({
        severity: "INFO",
        title: `Master with ${connectedSlaves} connected replica(s)`,
        detail: `Replication topology: master with ${connectedSlaves} active replica(s).`,
        recommendation: "No action needed.",
      });
    }

    // Check replication backlog
    if (!replBacklogActive) {
      findings.push({
        severity: "WARNING",
        title: "Replication backlog not active",
        detail: "The replication backlog is not active. Partial resynchronization will not be possible after disconnections.",
        recommendation: "The backlog activates automatically when replicas connect. If replicas are expected, investigate why none have connected.",
      });
    } else if (replBacklogSize < 1048576) {
      findings.push({
        severity: "WARNING",
        title: `Replication backlog too small (${formatBytes(replBacklogSize)})`,
        detail: `The replication backlog is ${formatBytes(replBacklogSize)}, which is below the recommended minimum of 1 MB. This increases the chance of full resynchronization after brief disconnections.`,
        recommendation: "Increase repl-backlog-size: CONFIG SET repl-backlog-size 16mb (or higher for write-heavy workloads).",
      });
    }

    // Check for partial resync failures via second_repl_offset
    if (secondReplOffset > 0) {
      findings.push({
        severity: "INFO",
        title: "Partial resync offset detected",
        detail: `second_repl_offset is ${secondReplOffset}, indicating a previous replication ID change (failover or restart).`,
        recommendation: "This is normal after failover events. Monitor for repeated occurrences.",
      });
    }
  } else if (role === "slave") {
    // Replica with broken link to master
    if (masterLinkStatus && masterLinkStatus !== "up") {
      findings.push({
        severity: "CRITICAL",
        title: `Master link status: ${masterLinkStatus}`,
        detail: `The connection to the master is ${masterLinkStatus}. This replica is not receiving updates and may serve stale data.`,
        recommendation: "Check master availability, network connectivity, and authentication configuration. Review Redis logs for connection errors.",
      });
    } else if (masterLinkStatus === "up") {
      findings.push({
        severity: "INFO",
        title: "Master link status: up",
        detail: "The connection to the master is healthy.",
        recommendation: "No action needed.",
      });
    }

    // High replication lag
    if (masterLastIoSecondsAgo > 10) {
      findings.push({
        severity: "WARNING",
        title: `High replication lag (${masterLastIoSecondsAgo}s since last master I/O)`,
        detail: `Last data received from master was ${masterLastIoSecondsAgo} seconds ago. This may indicate network issues or a heavily loaded master.`,
        recommendation: "Check master health and network latency. Values above 10 seconds suggest connectivity problems or master overload.",
      });
    }

    // Sync in progress
    if (masterSyncInProgress) {
      findings.push({
        severity: "WARNING",
        title: "Full synchronization in progress",
        detail: "This replica is currently performing a full resynchronization with the master. During this process, the replica may serve stale or incomplete data.",
        recommendation: "Wait for synchronization to complete. If this happens frequently, increase repl-backlog-size on the master to enable partial resynchronization.",
      });
    }
  }

  if (findings.length === 0) {
    findings.push({
      severity: "INFO",
      title: "Replication health looks good",
      detail: `Role: ${role}, no issues detected.`,
      recommendation: "No issues detected. Continue monitoring.",
    });
  }

  const criticalCount = findings.filter((f) => f.severity === "CRITICAL").length;
  const warningCount = findings.filter((f) => f.severity === "WARNING").length;
  const summary =
    criticalCount > 0
      ? `CRITICAL: ${criticalCount} critical replication issue(s) found`
      : warningCount > 0
        ? `WARNING: ${warningCount} replication warning(s) found`
        : `Replication OK (role: ${role})`;

  return {
    role,
    connectedSlaves,
    masterLinkStatus,
    masterLastIoSecondsAgo,
    replBacklogActive,
    replBacklogSize,
    secondReplOffset,
    masterSyncInProgress,
    findings,
    summary,
  };
}

export function formatReplicationAnalysis(analysis: ReplicationAnalysis): string {
  const lines: string[] = [];

  lines.push("# Redis Replication Analysis");
  lines.push("");
  lines.push(`**Status:** ${analysis.summary}`);
  lines.push("");
  lines.push("## Replication Overview");
  lines.push(`- Role: ${analysis.role}`);

  if (analysis.role === "master") {
    lines.push(`- Connected Replicas: ${analysis.connectedSlaves}`);
    lines.push(`- Backlog Active: ${analysis.replBacklogActive ? "yes" : "no"}`);
    lines.push(`- Backlog Size: ${formatBytes(analysis.replBacklogSize)}`);
  } else if (analysis.role === "slave") {
    lines.push(`- Master Link Status: ${analysis.masterLinkStatus || "unknown"}`);
    lines.push(`- Last Master I/O: ${analysis.masterLastIoSecondsAgo}s ago`);
    lines.push(`- Sync In Progress: ${analysis.masterSyncInProgress ? "yes" : "no"}`);
  }

  lines.push("");
  lines.push("## Findings");

  for (const finding of analysis.findings) {
    lines.push("");
    lines.push(`### [${finding.severity}] ${finding.title}`);
    lines.push(finding.detail);
    lines.push(`**Recommendation:** ${finding.recommendation}`);
  }

  return lines.join("\n");
}
