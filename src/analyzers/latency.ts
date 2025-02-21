/**
 * Redis LATENCY analyzer.
 * Parses LATENCY LATEST and LATENCY HISTORY output.
 * Detects: fork latency spikes, AOF fsync delays, command processing delays.
 */

export interface LatencyEvent {
  event: string;
  timestamp: number; // unix epoch seconds
  latencyMs: number;
  maxLatencyMs: number;
}

export interface LatencyHistoryEntry {
  timestamp: number;
  latencyMs: number;
}

export interface LatencyFinding {
  severity: "CRITICAL" | "WARNING" | "INFO";
  title: string;
  detail: string;
  recommendation: string;
}

export interface LatencyAnalysis {
  events: LatencyEvent[];
  history: Record<string, LatencyHistoryEntry[]>;
  findings: LatencyFinding[];
  summary: string;
}

/** Known latency event types and their descriptions */
const EVENT_DESCRIPTIONS: Record<string, string> = {
  "command": "Slow command execution",
  "fast-command": "O(1)/O(log N) command unexpectedly slow",
  "fork": "Fork for background save (RDB/AOF rewrite)",
  "rdb-unlink-temp-file": "Unlinking temp RDB file",
  "aof-fsync-always": "AOF fsync (appendfsync=always)",
  "aof-write": "AOF write to disk",
  "aof-write-pending-fsync": "AOF write with pending fsync",
  "aof-write-active-child": "AOF write during child process",
  "aof-rewrite-diff-write": "Writing AOF diff during rewrite",
  "active-defrag-cycle": "Active memory defragmentation",
  "expire-cycle": "Key expiration cycle",
  "eviction-cycle": "Memory eviction cycle",
  "eviction-del": "Deleting key during eviction",
};

/**
 * Parse LATENCY LATEST output.
 * Redis returns: [[event, timestamp, latencyMs, maxLatencyMs], ...]
 */
export function parseLatencyLatest(raw: unknown[]): LatencyEvent[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter(Array.isArray)
    .map((entry) => ({
      event: String(entry[0] ?? ""),
      timestamp: typeof entry[1] === "number" ? entry[1] : parseInt(String(entry[1]), 10) || 0,
      latencyMs: typeof entry[2] === "number" ? entry[2] : parseInt(String(entry[2]), 10) || 0,
      maxLatencyMs: typeof entry[3] === "number" ? entry[3] : parseInt(String(entry[3]), 10) || 0,
    }));
}

/**
 * Parse LATENCY HISTORY output for a specific event.
 * Redis returns: [[timestamp, latencyMs], ...]
 */
export function parseLatencyHistory(raw: unknown[]): LatencyHistoryEntry[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter(Array.isArray)
    .map((entry) => ({
      timestamp: typeof entry[0] === "number" ? entry[0] : parseInt(String(entry[0]), 10) || 0,
      latencyMs: typeof entry[1] === "number" ? entry[1] : parseInt(String(entry[1]), 10) || 0,
    }));
}

export function analyzeLatency(
  events: LatencyEvent[],
  history: Record<string, LatencyHistoryEntry[]> = {}
): LatencyAnalysis {
  const findings: LatencyFinding[] = [];

  if (events.length === 0) {
    findings.push({
      severity: "INFO",
      title: "No latency events recorded",
      detail: "LATENCY LATEST returned no events. Either latency monitoring is disabled or no spikes exceeded the threshold.",
      recommendation: "Enable latency monitoring: CONFIG SET latency-monitor-threshold 100 (tracks events >100ms).",
    });

    return { events, history, findings, summary: "No latency events — monitoring may be disabled" };
  }

  for (const event of events) {
    const desc = EVENT_DESCRIPTIONS[event.event] || event.event;

    // Fork latency
    if (event.event === "fork") {
      if (event.maxLatencyMs > 500) {
        findings.push({
          severity: "CRITICAL",
          title: `Fork latency spike: ${event.maxLatencyMs}ms`,
          detail: `${desc}. Background save fork took ${event.maxLatencyMs}ms (last: ${event.latencyMs}ms). Redis is single-threaded — forks block ALL operations.`,
          recommendation: "Reduce dataset size, increase server RAM (copy-on-write needs ~2x), or use replica for persistence. Consider CONFIG SET save '' to disable RDB.",
        });
      } else if (event.maxLatencyMs > 100) {
        findings.push({
          severity: "WARNING",
          title: `Fork latency: ${event.maxLatencyMs}ms max`,
          detail: `${desc}. Max: ${event.maxLatencyMs}ms, last: ${event.latencyMs}ms.`,
          recommendation: "Fork latency increases with dataset size. Monitor growth. Consider using replica for persistence.",
        });
      }
    }

    // AOF fsync latency
    if (event.event.startsWith("aof-")) {
      if (event.maxLatencyMs > 200) {
        findings.push({
          severity: "CRITICAL",
          title: `AOF latency spike: ${event.event} (${event.maxLatencyMs}ms)`,
          detail: `${desc}. Max: ${event.maxLatencyMs}ms, last: ${event.latencyMs}ms. Slow disk I/O is blocking Redis.`,
          recommendation: "Switch to faster disk (SSD/NVMe). If using appendfsync=always, consider appendfsync=everysec. Check for I/O contention from other processes.",
        });
      } else if (event.maxLatencyMs > 50) {
        findings.push({
          severity: "WARNING",
          title: `AOF latency: ${event.event} (${event.maxLatencyMs}ms max)`,
          detail: `${desc}. Max: ${event.maxLatencyMs}ms, last: ${event.latencyMs}ms.`,
          recommendation: "Consider appendfsync=everysec if data durability allows. Use IO-capable hardware.",
        });
      }
    }

    // Command latency
    if (event.event === "command" || event.event === "fast-command") {
      if (event.maxLatencyMs > 100) {
        findings.push({
          severity: event.maxLatencyMs > 500 ? "CRITICAL" : "WARNING",
          title: `${desc}: ${event.maxLatencyMs}ms max`,
          detail: `Commands taking up to ${event.maxLatencyMs}ms (last: ${event.latencyMs}ms). This blocks the Redis event loop.`,
          recommendation: event.event === "fast-command"
            ? "O(1) commands should never be this slow. Check for transparent huge pages (disable: echo never > /sys/kernel/mm/transparent_hugepage/enabled), swap, or CPU throttling."
            : "Review SLOWLOG for specific commands. Break large operations into smaller batches.",
        });
      }
    }

    // Eviction and expiry latency
    if (event.event === "eviction-cycle" || event.event === "expire-cycle") {
      if (event.maxLatencyMs > 100) {
        findings.push({
          severity: "WARNING",
          title: `${desc}: ${event.maxLatencyMs}ms max`,
          detail: `${desc} taking ${event.maxLatencyMs}ms. This happens when many keys expire/evict simultaneously.`,
          recommendation: event.event === "eviction-cycle"
            ? "Increase maxmemory or reduce data volume. Consider eviction policy change."
            : "Distribute TTLs to avoid thundering herd expirations. Add jitter to TTL values.",
        });
      }
    }

    // Active defrag
    if (event.event === "active-defrag-cycle" && event.maxLatencyMs > 100) {
      findings.push({
        severity: "WARNING",
        title: `Active defrag latency: ${event.maxLatencyMs}ms max`,
        detail: `Defragmentation cycle taking ${event.maxLatencyMs}ms.`,
        recommendation: "Reduce active-defrag-cycle-max-cpu-percent to limit impact. Consider scheduling defrag during low-traffic periods.",
      });
    }

    // Generic high latency for unrecognized events
    if (
      !["fork", "command", "fast-command", "eviction-cycle", "expire-cycle", "active-defrag-cycle"].includes(event.event) &&
      !event.event.startsWith("aof-") &&
      event.maxLatencyMs > 200
    ) {
      findings.push({
        severity: "WARNING",
        title: `${desc}: ${event.maxLatencyMs}ms max`,
        detail: `Latency event '${event.event}' peaked at ${event.maxLatencyMs}ms (last: ${event.latencyMs}ms).`,
        recommendation: "Investigate the root cause. Check system resources (CPU, memory, disk I/O).",
      });
    }
  }

  // Check history for trends (if provided)
  for (const [event, entries] of Object.entries(history)) {
    if (entries.length < 3) continue;

    // Check if latency is increasing (last 3 entries trending up)
    const recent = entries.slice(-3);
    if (recent.length === 3 && recent[0].latencyMs < recent[1].latencyMs && recent[1].latencyMs < recent[2].latencyMs) {
      findings.push({
        severity: "WARNING",
        title: `Increasing latency trend: ${event}`,
        detail: `Last 3 measurements show increasing latency: ${recent.map((e) => `${e.latencyMs}ms`).join(" → ")}.`,
        recommendation: "Latency is trending upward. Investigate before it becomes critical.",
      });
    }
  }

  if (findings.length === 0) {
    findings.push({
      severity: "INFO",
      title: "Latency events within acceptable range",
      detail: `${events.length} event type(s) recorded, all within normal parameters.`,
      recommendation: "Continue monitoring. Current latency profile is healthy.",
    });
  }

  const criticalCount = findings.filter((f) => f.severity === "CRITICAL").length;
  const warningCount = findings.filter((f) => f.severity === "WARNING").length;
  const summary =
    criticalCount > 0
      ? `CRITICAL: ${criticalCount} critical latency issue(s)`
      : warningCount > 0
        ? `WARNING: ${warningCount} latency warning(s)`
        : `OK: ${events.length} latency event(s), all within normal range`;

  return { events, history, findings, summary };
}

export function formatLatencyAnalysis(analysis: LatencyAnalysis): string {
  const lines: string[] = [];

  lines.push("# Redis Latency Analysis");
  lines.push("");
  lines.push(`**Status:** ${analysis.summary}`);

  if (analysis.events.length > 0) {
    lines.push("");
    lines.push("## Latest Events");
    lines.push("| Event | Last (ms) | Max (ms) | Description |");
    lines.push("|-------|-----------|----------|-------------|");

    for (const event of analysis.events) {
      const desc = EVENT_DESCRIPTIONS[event.event] || event.event;
      lines.push(`| ${event.event} | ${event.latencyMs} | ${event.maxLatencyMs} | ${desc} |`);
    }
  }

  if (Object.keys(analysis.history).length > 0) {
    lines.push("");
    lines.push("## Event History");

    for (const [event, entries] of Object.entries(analysis.history)) {
      if (entries.length === 0) continue;
      lines.push("");
      lines.push(`### ${event}`);
      const recent = entries.slice(-10);
      lines.push(`Last ${recent.length} entries: ${recent.map((e) => `${e.latencyMs}ms`).join(", ")}`);
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
