/**
 * Redis memory analyzer.
 * Detects fragmentation, eviction risk, RSS overhead, and maxmemory issues.
 */

import { type RedisInfo, infoNum, infoStr, formatBytes } from "../parsers/info.js";

export interface MemoryFinding {
  severity: "CRITICAL" | "WARNING" | "INFO";
  title: string;
  detail: string;
  recommendation: string;
}

export interface MemoryAnalysis {
  usedMemory: number;
  usedMemoryRss: number;
  usedMemoryPeak: number;
  maxMemory: number;
  fragmentationRatio: number;
  evictedKeys: number;
  maxMemoryPolicy: string;
  findings: MemoryFinding[];
  summary: string;
}

export function analyzeMemory(info: RedisInfo): MemoryAnalysis {
  const usedMemory = infoNum(info, "memory", "used_memory");
  const usedMemoryRss = infoNum(info, "memory", "used_memory_rss");
  const usedMemoryPeak = infoNum(info, "memory", "used_memory_peak");
  const maxMemory = infoNum(info, "memory", "maxmemory");
  const fragmentationRatio = infoNum(info, "memory", "mem_fragmentation_ratio");
  const evictedKeys = infoNum(info, "stats", "evicted_keys");
  const maxMemoryPolicy = infoStr(info, "memory", "maxmemory_policy") || "noeviction";

  const findings: MemoryFinding[] = [];

  // Check fragmentation
  if (fragmentationRatio > 1.5) {
    findings.push({
      severity: fragmentationRatio > 3.0 ? "CRITICAL" : "WARNING",
      title: `High memory fragmentation (${fragmentationRatio.toFixed(2)}x)`,
      detail: `RSS (${formatBytes(usedMemoryRss)}) is ${fragmentationRatio.toFixed(1)}x larger than used memory (${formatBytes(usedMemory)}). This means ${formatBytes(usedMemoryRss - usedMemory)} is wasted on fragmentation.`,
      recommendation:
        fragmentationRatio > 3.0
          ? "Consider restarting Redis to reclaim fragmented memory. Enable activedefrag (CONFIG SET activedefrag yes) for automatic defragmentation."
          : "Enable activedefrag (CONFIG SET activedefrag yes) to reduce fragmentation over time.",
    });
  } else if (fragmentationRatio < 1.0 && fragmentationRatio > 0) {
    findings.push({
      severity: "WARNING",
      title: `Memory fragmentation below 1.0 (${fragmentationRatio.toFixed(2)}x)`,
      detail: `RSS (${formatBytes(usedMemoryRss)}) < used memory (${formatBytes(usedMemory)}). Redis is likely swapping to disk.`,
      recommendation: "Increase available system memory or reduce Redis memory usage. Swapping severely impacts performance.",
    });
  }

  // Check maxmemory
  if (maxMemory > 0) {
    const usagePercent = (usedMemory / maxMemory) * 100;
    if (usagePercent > 90) {
      findings.push({
        severity: "CRITICAL",
        title: `Memory usage at ${usagePercent.toFixed(1)}% of maxmemory`,
        detail: `Using ${formatBytes(usedMemory)} of ${formatBytes(maxMemory)} limit.`,
        recommendation:
          maxMemoryPolicy === "noeviction"
            ? "URGENT: With noeviction policy, writes will fail when maxmemory is reached. Either increase maxmemory or set an eviction policy (allkeys-lru recommended for caches)."
            : `Eviction policy '${maxMemoryPolicy}' is active. Consider increasing maxmemory or optimizing data structures to reduce memory usage.`,
      });
    } else if (usagePercent > 75) {
      findings.push({
        severity: "WARNING",
        title: `Memory usage at ${usagePercent.toFixed(1)}% of maxmemory`,
        detail: `Using ${formatBytes(usedMemory)} of ${formatBytes(maxMemory)} limit.`,
        recommendation: "Monitor closely. Consider increasing maxmemory or reviewing TTL policies.",
      });
    }
  } else {
    findings.push({
      severity: "WARNING",
      title: "No maxmemory limit set",
      detail: "Redis will use all available system memory without limits.",
      recommendation: "Set maxmemory to prevent OOM kills: CONFIG SET maxmemory <bytes>. For caches, combine with allkeys-lru eviction policy.",
    });
  }

  // Check peak usage
  if (usedMemoryPeak > 0 && usedMemory > 0) {
    const peakRatio = usedMemoryPeak / usedMemory;
    if (peakRatio > 2.0) {
      findings.push({
        severity: "INFO",
        title: `Peak memory was ${peakRatio.toFixed(1)}x current usage`,
        detail: `Peak: ${formatBytes(usedMemoryPeak)}, current: ${formatBytes(usedMemory)}. This may indicate a large batch operation or memory leak that was resolved.`,
        recommendation: "If this pattern repeats, investigate what caused the spike (large SORT, DEBUG RELOAD, background saves).",
      });
    }
  }

  // Check eviction
  if (evictedKeys > 0) {
    findings.push({
      severity: evictedKeys > 10000 ? "WARNING" : "INFO",
      title: `${evictedKeys.toLocaleString()} keys evicted`,
      detail: `Redis has evicted ${evictedKeys.toLocaleString()} keys using the '${maxMemoryPolicy}' policy.`,
      recommendation:
        evictedKeys > 10000
          ? "High eviction count suggests maxmemory is too low for the workload. Increase maxmemory or reduce data volume."
          : "Some eviction is normal for cache workloads. Monitor hit rate to ensure eviction isn't impacting performance.",
    });
  }

  // Check noeviction policy with high memory.
  // Skip if a maxmemory pressure finding was already added (>75% or >90%) — those
  // findings already include noeviction-specific guidance in their recommendations.
  const hasPressureFinding = findings.some(
    (f) => f.title.includes("maxmemory") && (f.severity === "CRITICAL" || f.severity === "WARNING")
  );
  if (maxMemoryPolicy === "noeviction" && maxMemory > 0 && !hasPressureFinding) {
    findings.push({
      severity: "WARNING",
      title: "Using noeviction policy",
      detail: "When maxmemory is reached, all write commands will return errors.",
      recommendation: "For cache workloads, use allkeys-lru. For mixed workloads with important keys, use volatile-lru (only evicts keys with TTL).",
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: "INFO",
      title: "Memory health looks good",
      detail: `Using ${formatBytes(usedMemory)} with fragmentation ratio ${fragmentationRatio.toFixed(2)}x.`,
      recommendation: "No issues detected. Continue monitoring.",
    });
  }

  const criticalCount = findings.filter((f) => f.severity === "CRITICAL").length;
  const warningCount = findings.filter((f) => f.severity === "WARNING").length;
  const summary =
    criticalCount > 0
      ? `CRITICAL: ${criticalCount} critical memory issue(s) found`
      : warningCount > 0
        ? `WARNING: ${warningCount} memory warning(s) found`
        : "Memory health OK";

  return {
    usedMemory,
    usedMemoryRss,
    usedMemoryPeak,
    maxMemory,
    fragmentationRatio,
    evictedKeys,
    maxMemoryPolicy,
    findings,
    summary,
  };
}

export function formatMemoryAnalysis(analysis: MemoryAnalysis): string {
  const lines: string[] = [];

  lines.push("# Redis Memory Analysis");
  lines.push("");
  lines.push(`**Status:** ${analysis.summary}`);
  lines.push("");
  lines.push("## Memory Overview");
  lines.push(`- Used Memory: ${formatBytes(analysis.usedMemory)}`);
  lines.push(`- RSS Memory: ${formatBytes(analysis.usedMemoryRss)}`);
  lines.push(`- Peak Memory: ${formatBytes(analysis.usedMemoryPeak)}`);
  lines.push(
    `- Max Memory: ${analysis.maxMemory > 0 ? formatBytes(analysis.maxMemory) : "unlimited"}`
  );
  lines.push(`- Fragmentation Ratio: ${analysis.fragmentationRatio.toFixed(2)}x`);
  lines.push(`- Eviction Policy: ${analysis.maxMemoryPolicy}`);
  lines.push(`- Evicted Keys: ${analysis.evictedKeys.toLocaleString()}`);

  if (analysis.maxMemory > 0) {
    const pct = ((analysis.usedMemory / analysis.maxMemory) * 100).toFixed(1);
    lines.push(`- Memory Utilization: ${pct}%`);
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
