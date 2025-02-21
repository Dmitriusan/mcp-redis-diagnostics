/**
 * Redis keyspace analyzer.
 * Analyzes key distribution across databases, TTL coverage, and expiry rates.
 */

import {
  type RedisInfo,
  type KeyspaceDB,
  parseKeyspaceEntries,
  infoNum,
} from "../parsers/info.js";

export interface KeyspaceFinding {
  severity: "CRITICAL" | "WARNING" | "INFO";
  title: string;
  detail: string;
  recommendation: string;
}

export interface KeyspaceAnalysis {
  totalKeys: number;
  totalExpires: number;
  ttlCoveragePct: number;
  databases: KeyspaceDB[];
  expiredKeys: number;
  evictedKeys: number;
  hitRate: number;
  findings: KeyspaceFinding[];
  summary: string;
}

export function analyzeKeyspace(info: RedisInfo): KeyspaceAnalysis {
  const databases = parseKeyspaceEntries(info);
  const totalKeys = databases.reduce((sum, db) => sum + db.keys, 0);
  const totalExpires = databases.reduce((sum, db) => sum + db.expires, 0);
  const ttlCoveragePct = totalKeys > 0 ? (totalExpires / totalKeys) * 100 : 0;

  const expiredKeys = infoNum(info, "stats", "expired_keys");
  const evictedKeys = infoNum(info, "stats", "evicted_keys");
  const keyspaceHits = infoNum(info, "stats", "keyspace_hits");
  const keyspaceMisses = infoNum(info, "stats", "keyspace_misses");
  const totalOps = keyspaceHits + keyspaceMisses;
  const hitRate = totalOps > 0 ? (keyspaceHits / totalOps) * 100 : 0;

  const findings: KeyspaceFinding[] = [];

  // Check TTL coverage
  if (totalKeys > 0 && ttlCoveragePct < 20) {
    findings.push({
      severity: "WARNING",
      title: `Low TTL coverage: ${ttlCoveragePct.toFixed(1)}%`,
      detail: `Only ${totalExpires.toLocaleString()} of ${totalKeys.toLocaleString()} keys have TTLs set. Keys without TTLs will persist indefinitely and consume memory.`,
      recommendation:
        "Set TTLs on cache keys to prevent unbounded memory growth. Use EXPIRE or set TTL at write time with SET key value EX seconds.",
    });
  }

  // Check hit rate
  if (totalOps > 100) {
    if (hitRate < 80) {
      findings.push({
        severity: hitRate < 50 ? "CRITICAL" : "WARNING",
        title: `Low cache hit rate: ${hitRate.toFixed(1)}%`,
        detail: `${keyspaceHits.toLocaleString()} hits vs ${keyspaceMisses.toLocaleString()} misses. A hit rate below 80% suggests cache strategy issues.`,
        recommendation:
          hitRate < 50
            ? "URGENT: Hit rate below 50% — cache is not effective. Review cache keys, TTL strategy, and client access patterns. Consider if the cached data matches query patterns."
            : "Review cache warming strategy and TTL durations. Ensure clients are reading from cache before fallback to primary storage.",
      });
    } else {
      findings.push({
        severity: "INFO",
        title: `Cache hit rate: ${hitRate.toFixed(1)}%`,
        detail: `${keyspaceHits.toLocaleString()} hits, ${keyspaceMisses.toLocaleString()} misses.`,
        recommendation: "Hit rate is healthy. Continue monitoring.",
      });
    }
  }

  // Check for multiple databases in use
  if (databases.length > 3) {
    findings.push({
      severity: "WARNING",
      title: `${databases.length} Redis databases in use`,
      detail: `Using databases: ${databases.map((d) => `${d.db} (${d.keys.toLocaleString()} keys)`).join(", ")}.`,
      recommendation:
        "Multiple Redis databases add operational complexity. Redis Cluster doesn't support multiple databases. Consider using key prefixes instead.",
    });
  }

  // Check for unbalanced distribution
  if (databases.length > 1) {
    const maxKeys = Math.max(...databases.map((d) => d.keys));
    const minKeys = Math.min(...databases.map((d) => d.keys));
    if (maxKeys > 0 && minKeys > 0 && maxKeys / minKeys > 100) {
      const largest = databases.find((d) => d.keys === maxKeys);
      const smallest = databases.find((d) => d.keys === minKeys);
      findings.push({
        severity: "INFO",
        title: "Highly unbalanced database distribution",
        detail: `${largest?.db} has ${maxKeys.toLocaleString()} keys while ${smallest?.db} has only ${minKeys.toLocaleString()} keys (${(maxKeys / minKeys).toFixed(0)}x difference).`,
        recommendation: "Consider consolidating small databases into the primary DB using key prefixes.",
      });
    }
  }

  // Check high expiry rate
  if (expiredKeys > 1000000) {
    findings.push({
      severity: "INFO",
      title: `${expiredKeys.toLocaleString()} keys expired since start`,
      detail: "High expired key count indicates active TTL-based cache management.",
      recommendation:
        "This is normal for cache workloads. If expired_stale_perc (from INFO stats) is high, Redis may be struggling to keep up with expirations.",
    });
  }

  // Check empty keyspace
  if (totalKeys === 0) {
    findings.push({
      severity: "INFO",
      title: "Keyspace is empty",
      detail: "No keys found in any database.",
      recommendation: "Redis is running but has no data. This may be expected for a fresh instance.",
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: "INFO",
      title: "Keyspace looks healthy",
      detail: `${totalKeys.toLocaleString()} keys, ${ttlCoveragePct.toFixed(1)}% have TTLs.`,
      recommendation: "No issues detected.",
    });
  }

  const criticalCount = findings.filter((f) => f.severity === "CRITICAL").length;
  const warningCount = findings.filter((f) => f.severity === "WARNING").length;
  const summary =
    criticalCount > 0
      ? `CRITICAL: ${criticalCount} critical keyspace issue(s)`
      : warningCount > 0
        ? `WARNING: ${warningCount} keyspace warning(s)`
        : `OK: ${totalKeys.toLocaleString()} keys, ${hitRate.toFixed(1)}% hit rate`;

  return {
    totalKeys,
    totalExpires,
    ttlCoveragePct,
    databases,
    expiredKeys,
    evictedKeys,
    hitRate,
    findings,
    summary,
  };
}

export function formatKeyspaceAnalysis(analysis: KeyspaceAnalysis): string {
  const lines: string[] = [];

  lines.push("# Redis Keyspace Analysis");
  lines.push("");
  lines.push(`**Status:** ${analysis.summary}`);
  lines.push("");
  lines.push("## Overview");
  lines.push(`- Total Keys: ${analysis.totalKeys.toLocaleString()}`);
  lines.push(`- Keys with TTL: ${analysis.totalExpires.toLocaleString()} (${analysis.ttlCoveragePct.toFixed(1)}%)`);
  lines.push(`- Expired Keys (total): ${analysis.expiredKeys.toLocaleString()}`);
  lines.push(`- Evicted Keys (total): ${analysis.evictedKeys.toLocaleString()}`);
  lines.push(`- Cache Hit Rate: ${analysis.hitRate.toFixed(1)}%`);

  if (analysis.databases.length > 0) {
    lines.push("");
    lines.push("## Database Distribution");
    lines.push("| Database | Keys | Expires | TTL Coverage | Avg TTL |");
    lines.push("|----------|------|---------|--------------|---------|");

    for (const db of analysis.databases) {
      const ttlPct = db.keys > 0 ? ((db.expires / db.keys) * 100).toFixed(1) : "0.0";
      const avgTtl = db.avgTtl > 0 ? `${(db.avgTtl / 1000).toFixed(0)}s` : "N/A";
      lines.push(`| ${db.db} | ${db.keys.toLocaleString()} | ${db.expires.toLocaleString()} | ${ttlPct}% | ${avgTtl} |`);
    }
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
