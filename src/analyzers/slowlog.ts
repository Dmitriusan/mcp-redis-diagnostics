/**
 * Redis SLOWLOG analyzer.
 * Parses SLOWLOG GET output and identifies problematic command patterns.
 */

export interface SlowlogEntry {
  id: number;
  timestamp: number;
  duration: number; // microseconds
  command: string[];
  clientAddr: string;
  clientName: string;
}

export interface SlowlogFinding {
  severity: "CRITICAL" | "WARNING" | "INFO";
  title: string;
  detail: string;
  recommendation: string;
}

export interface SlowlogAnalysis {
  totalEntries: number;
  slowlogThreshold: number; // microseconds
  worstLatency: number; // microseconds
  avgLatency: number;
  commandBreakdown: Record<string, { count: number; totalDuration: number; maxDuration: number }>;
  findings: SlowlogFinding[];
  summary: string;
}

/**
 * Parse SLOWLOG GET results.
 * Redis returns arrays: [id, timestamp, duration, [cmd, args...], clientAddr, clientName]
 */
export function parseSlowlogEntries(raw: unknown[]): SlowlogEntry[] {
  if (!Array.isArray(raw)) return [];

  return raw.map((entry) => {
    if (!Array.isArray(entry)) {
      return { id: 0, timestamp: 0, duration: 0, command: [], clientAddr: "", clientName: "" };
    }

    return {
      id: typeof entry[0] === "number" ? entry[0] : parseInt(String(entry[0]), 10) || 0,
      timestamp: typeof entry[1] === "number" ? entry[1] : parseInt(String(entry[1]), 10) || 0,
      duration: typeof entry[2] === "number" ? entry[2] : parseInt(String(entry[2]), 10) || 0,
      command: Array.isArray(entry[3]) ? entry[3].map(String) : [],
      clientAddr: String(entry[4] ?? ""),
      clientName: String(entry[5] ?? ""),
    };
  });
}

/** Known O(N) commands that are dangerous in production */
const DANGEROUS_COMMANDS = new Set([
  "KEYS",
  "SMEMBERS",
  "HGETALL",
  "LRANGE",
  "SORT",
  "FLUSHDB",
  "FLUSHALL",
  "DEBUG",
]);

/** Commands with safer alternatives */
const SAFER_ALTERNATIVES: Record<string, string> = {
  KEYS: "Use SCAN instead of KEYS for production key iteration",
  SMEMBERS: "Use SSCAN for large sets instead of SMEMBERS",
  HGETALL: "Use HSCAN for large hashes instead of HGETALL",
  LRANGE: "Use pagination with LRANGE (small ranges) or consider a different data structure",
  SORT: "Pre-sort data or use sorted sets (ZADD/ZRANGEBYSCORE) instead of SORT",
};

export function analyzeSlowlog(entries: SlowlogEntry[], thresholdUs: number = 10000): SlowlogAnalysis {
  const commandBreakdown: Record<string, { count: number; totalDuration: number; maxDuration: number }> = {};

  let worstLatency = 0;
  let totalDuration = 0;

  for (const entry of entries) {
    const cmd = (entry.command[0] || "UNKNOWN").toUpperCase();

    if (!commandBreakdown[cmd]) {
      commandBreakdown[cmd] = { count: 0, totalDuration: 0, maxDuration: 0 };
    }
    commandBreakdown[cmd].count++;
    commandBreakdown[cmd].totalDuration += entry.duration;
    commandBreakdown[cmd].maxDuration = Math.max(commandBreakdown[cmd].maxDuration, entry.duration);

    worstLatency = Math.max(worstLatency, entry.duration);
    totalDuration += entry.duration;
  }

  const avgLatency = entries.length > 0 ? totalDuration / entries.length : 0;
  const findings: SlowlogFinding[] = [];

  // Check for dangerous commands
  for (const cmd of Object.keys(commandBreakdown)) {
    if (DANGEROUS_COMMANDS.has(cmd)) {
      const stats = commandBreakdown[cmd];
      findings.push({
        severity: cmd === "KEYS" || cmd === "FLUSHALL" || cmd === "FLUSHDB" ? "CRITICAL" : "WARNING",
        title: `Dangerous command detected: ${cmd} (${stats.count} occurrences)`,
        detail: `${cmd} appeared ${stats.count} times in slowlog. Max duration: ${(stats.maxDuration / 1000).toFixed(1)}ms. Total time: ${(stats.totalDuration / 1000).toFixed(1)}ms.`,
        recommendation: SAFER_ALTERNATIVES[cmd] || `Avoid ${cmd} in production — it blocks the Redis event loop.`,
      });
    }
  }

  // Check worst latency
  if (worstLatency > 100000) {
    // > 100ms
    findings.push({
      severity: "CRITICAL",
      title: `Worst latency: ${(worstLatency / 1000).toFixed(1)}ms`,
      detail: `A single command took ${(worstLatency / 1000).toFixed(1)}ms. Redis is single-threaded — this blocks ALL other commands.`,
      recommendation: "Investigate the slow command. Break large operations into smaller batches using pipelines or SCAN-based iteration.",
    });
  } else if (worstLatency > 10000) {
    // > 10ms
    findings.push({
      severity: "WARNING",
      title: `Worst latency: ${(worstLatency / 1000).toFixed(1)}ms`,
      detail: `A command took ${(worstLatency / 1000).toFixed(1)}ms. This exceeds the typical 1ms Redis target.`,
      recommendation: "Review the command and consider optimizing data structures or reducing payload sizes.",
    });
  }

  // Check if slowlog is full (128 entries = default max)
  if (entries.length >= 128) {
    findings.push({
      severity: "INFO",
      title: "Slowlog buffer is full (128 entries)",
      detail: "The default slowlog-max-len is 128. Older slow commands have been dropped.",
      recommendation: "Increase slowlog-max-len (CONFIG SET slowlog-max-len 1024) to capture more history for analysis.",
    });
  }

  // Check command concentration
  const sortedCmds = Object.entries(commandBreakdown).sort((a, b) => b[1].count - a[1].count);
  if (sortedCmds.length > 0 && entries.length > 5) {
    const topCmd = sortedCmds[0];
    const topPct = (topCmd[1].count / entries.length) * 100;
    if (topPct > 50) {
      findings.push({
        severity: "WARNING",
        title: `${topCmd[0]} dominates slowlog (${topPct.toFixed(0)}% of entries)`,
        detail: `${topCmd[0]} accounts for ${topCmd[1].count} of ${entries.length} slow commands.`,
        recommendation: `Focus optimization efforts on ${topCmd[0]} — it's the primary source of latency.`,
      });
    }
  }

  if (entries.length === 0) {
    findings.push({
      severity: "INFO",
      title: "Slowlog is empty",
      detail: `No commands exceeded the slowlog threshold (${thresholdUs / 1000}ms).`,
      recommendation: "All commands are completing within acceptable latency. Continue monitoring.",
    });
  }

  const criticalCount = findings.filter((f) => f.severity === "CRITICAL").length;
  const warningCount = findings.filter((f) => f.severity === "WARNING").length;
  const summary =
    criticalCount > 0
      ? `CRITICAL: ${criticalCount} critical slowlog issue(s)`
      : warningCount > 0
        ? `WARNING: ${warningCount} slowlog warning(s)`
        : entries.length === 0
          ? "Slowlog clean — no slow commands detected"
          : `OK: ${entries.length} slow commands logged, no critical issues`;

  return {
    totalEntries: entries.length,
    slowlogThreshold: thresholdUs,
    worstLatency,
    avgLatency,
    commandBreakdown,
    findings,
    summary,
  };
}

export function formatSlowlogAnalysis(analysis: SlowlogAnalysis): string {
  const lines: string[] = [];

  lines.push("# Redis Slowlog Analysis");
  lines.push("");
  lines.push(`**Status:** ${analysis.summary}`);
  lines.push("");
  lines.push("## Overview");
  lines.push(`- Slow commands logged: ${analysis.totalEntries}`);
  lines.push(`- Slowlog threshold: ${(analysis.slowlogThreshold / 1000).toFixed(1)}ms`);
  lines.push(`- Worst latency: ${(analysis.worstLatency / 1000).toFixed(1)}ms`);
  lines.push(`- Average latency: ${(analysis.avgLatency / 1000).toFixed(1)}ms`);

  if (Object.keys(analysis.commandBreakdown).length > 0) {
    lines.push("");
    lines.push("## Command Breakdown");
    lines.push("| Command | Count | Avg (ms) | Max (ms) | Total (ms) |");
    lines.push("|---------|-------|----------|----------|------------|");

    const sorted = Object.entries(analysis.commandBreakdown).sort(
      (a, b) => b[1].totalDuration - a[1].totalDuration
    );

    for (const [cmd, stats] of sorted) {
      const avg = stats.count > 0 ? stats.totalDuration / stats.count : 0;
      lines.push(
        `| ${cmd} | ${stats.count} | ${(avg / 1000).toFixed(1)} | ${(stats.maxDuration / 1000).toFixed(1)} | ${(stats.totalDuration / 1000).toFixed(1)} |`
      );
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
