/**
 * Redis CLIENT LIST analyzer.
 * Detects blocked clients, idle connections, connection storms.
 */

import { type RedisInfo, infoNum } from "../parsers/info.js";

export interface ClientEntry {
  id: string;
  addr: string;
  fd: string;
  name: string;
  age: number; // seconds
  idle: number; // seconds
  flags: string;
  db: number;
  cmd: string;
  qbuf: number;
  qbufFree: number;
  obl: number;
  oll: number;
  omem: number;
}

export interface ClientFinding {
  severity: "CRITICAL" | "WARNING" | "INFO";
  title: string;
  detail: string;
  recommendation: string;
}

export interface ClientAnalysis {
  totalClients: number;
  connectedClients: number;
  blockedClients: number;
  maxClients: number;
  idleConnections: number;
  findings: ClientFinding[];
  summary: string;
}

/**
 * Parse CLIENT LIST output. Each line is a client entry with key=value pairs.
 */
export function parseClientList(raw: string): ClientEntry[] {
  if (!raw.trim()) return [];

  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const pairs: Record<string, string> = {};
      for (const pair of line.split(" ")) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx !== -1) {
          pairs[pair.substring(0, eqIdx)] = pair.substring(eqIdx + 1);
        }
      }

      return {
        id: pairs.id || "",
        addr: pairs.addr || "",
        fd: pairs.fd || "",
        name: pairs.name || "",
        age: parseInt(pairs.age || "0", 10),
        idle: parseInt(pairs.idle || "0", 10),
        flags: pairs.flags || "",
        db: parseInt(pairs.db || "0", 10),
        cmd: pairs.cmd || "",
        qbuf: parseInt(pairs.qbuf || "0", 10),
        qbufFree: parseInt(pairs["qbuf-free"] || "0", 10),
        obl: parseInt(pairs.obl || "0", 10),
        oll: parseInt(pairs.oll || "0", 10),
        omem: parseInt(pairs.omem || "0", 10),
      };
    });
}

const IDLE_THRESHOLD = 300; // 5 minutes

export function analyzeClients(
  clients: ClientEntry[],
  info: RedisInfo
): ClientAnalysis {
  const connectedClients = infoNum(info, "clients", "connected_clients");
  const blockedClients = infoNum(info, "clients", "blocked_clients");
  const maxClients = infoNum(info, "server", "maxclients") || 10000;

  const idleConnections = clients.filter(
    (c) => c.idle > IDLE_THRESHOLD && !c.flags.includes("S") // exclude replicas
  ).length;

  const findings: ClientFinding[] = [];

  // Check blocked clients
  if (blockedClients > 0) {
    const blockedList = clients.filter((c) => c.flags.includes("b"));
    findings.push({
      severity: blockedClients > 10 ? "CRITICAL" : "WARNING",
      title: `${blockedClients} blocked client(s)`,
      detail: `Clients blocked on BLPOP/BRPOP/BLMOVE/BZPOPMIN/WAIT operations. Commands: ${[...new Set(blockedList.map((c) => c.cmd))].join(", ") || "unknown"}.`,
      recommendation:
        blockedClients > 10
          ? "Investigate why many clients are blocked. Potential producer/consumer imbalance."
          : "Some blocked clients are normal for queue-based workloads (BLPOP). Monitor for growth.",
    });
  }

  // Check connection count vs maxclients
  const connectionPct = (connectedClients / maxClients) * 100;
  if (connectionPct > 80) {
    findings.push({
      severity: connectionPct > 95 ? "CRITICAL" : "WARNING",
      title: `Connection usage at ${connectionPct.toFixed(1)}% (${connectedClients}/${maxClients})`,
      detail: `${connectedClients} connected clients out of ${maxClients} maximum.`,
      recommendation:
        connectionPct > 95
          ? "URGENT: Close to maxclients. New connections will be refused. Increase maxclients or reduce idle connections."
          : "Monitor connection growth. Consider increasing maxclients or implementing connection pooling.",
    });
  }

  // Check idle connections
  if (idleConnections > 0) {
    const idlePct = connectedClients > 0 ? (idleConnections / connectedClients) * 100 : 0;
    if (idlePct > 50 || idleConnections > 100) {
      findings.push({
        severity: "WARNING",
        title: `${idleConnections} idle connections (>${IDLE_THRESHOLD}s)`,
        detail: `${idleConnections} of ${connectedClients} connections have been idle for over ${IDLE_THRESHOLD} seconds (${idlePct.toFixed(0)}%).`,
        recommendation: "Configure client-side connection pooling with proper idle timeout. Set Redis 'timeout' config to auto-close idle connections.",
      });
    } else if (idleConnections > 0) {
      findings.push({
        severity: "INFO",
        title: `${idleConnections} idle connection(s)`,
        detail: `${idleConnections} connections idle for >${IDLE_THRESHOLD}s.`,
        recommendation: "Consider setting a connection timeout (CONFIG SET timeout 300).",
      });
    }
  }

  // Check output buffer memory
  const highOmemClients = clients.filter((c) => c.omem > 1024 * 1024); // > 1MB
  if (highOmemClients.length > 0) {
    const totalOmem = highOmemClients.reduce((sum, c) => sum + c.omem, 0);
    findings.push({
      severity: totalOmem > 100 * 1024 * 1024 ? "CRITICAL" : "WARNING",
      title: `${highOmemClients.length} client(s) with large output buffers`,
      detail: `${highOmemClients.length} clients have output buffer memory >1MB. Total: ${(totalOmem / 1024 / 1024).toFixed(1)}MB. Commands: ${[...new Set(highOmemClients.map((c) => c.cmd))].join(", ")}.`,
      recommendation: "Large output buffers indicate slow consumers or large responses. Review client-output-buffer-limit settings. Consider paginating large result sets.",
    });
  }

  // Check for pub/sub clients without subscriptions
  const pubsubClients = clients.filter((c) => c.flags.includes("S"));
  if (pubsubClients.length > 50) {
    findings.push({
      severity: "INFO",
      title: `${pubsubClients.length} pub/sub subscriber clients`,
      detail: `${pubsubClients.length} clients are in pub/sub mode.`,
      recommendation: "High pub/sub client count is normal for event-driven architectures. Ensure subscribers are processing messages efficiently.",
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: "INFO",
      title: "Client connections look healthy",
      detail: `${connectedClients} connected, 0 blocked, ${idleConnections} idle.`,
      recommendation: "No issues detected. Continue monitoring.",
    });
  }

  const criticalCount = findings.filter((f) => f.severity === "CRITICAL").length;
  const warningCount = findings.filter((f) => f.severity === "WARNING").length;
  const summary =
    criticalCount > 0
      ? `CRITICAL: ${criticalCount} critical client issue(s)`
      : warningCount > 0
        ? `WARNING: ${warningCount} client warning(s)`
        : `OK: ${connectedClients} clients connected, no issues`;

  return {
    totalClients: clients.length,
    connectedClients,
    blockedClients,
    maxClients,
    idleConnections,
    findings,
    summary,
  };
}

export function formatClientAnalysis(analysis: ClientAnalysis): string {
  const lines: string[] = [];

  lines.push("# Redis Client Analysis");
  lines.push("");
  lines.push(`**Status:** ${analysis.summary}`);
  lines.push("");
  lines.push("## Overview");
  lines.push(`- Connected Clients: ${analysis.connectedClients}`);
  lines.push(`- Max Clients: ${analysis.maxClients}`);
  lines.push(
    `- Utilization: ${((analysis.connectedClients / analysis.maxClients) * 100).toFixed(1)}%`
  );
  lines.push(`- Blocked Clients: ${analysis.blockedClients}`);
  lines.push(`- Idle Connections (>5min): ${analysis.idleConnections}`);

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
