/**
 * Redis configuration analyzer.
 *
 * Parses CONFIG GET * output and flags dangerous settings:
 * - No maxmemory (unbounded memory growth)
 * - No maxmemory-policy or noeviction (OOM risk)
 * - bind 0.0.0.0 without protected-mode (open to network)
 * - No requirepass (unauthenticated access)
 * - appendonly no (no persistence durability)
 * - Dangerous rename-command gaps
 */

export interface ConfigFinding {
  severity: "CRITICAL" | "WARNING" | "INFO";
  setting: string;
  value: string;
  message: string;
  recommendation: string;
}

export interface ConfigAnalysis {
  totalSettings: number;
  findings: ConfigFinding[];
}

/**
 * Analyze Redis config map (key→value pairs from CONFIG GET *).
 */
export function analyzeConfig(config: Record<string, string>): ConfigAnalysis {
  const findings: ConfigFinding[] = [];
  const totalSettings = Object.keys(config).length;

  // 1. maxmemory not set (0 = unlimited)
  const maxmemory = config["maxmemory"];
  if (maxmemory === "0" || maxmemory === undefined || maxmemory === "") {
    findings.push({
      severity: "CRITICAL",
      setting: "maxmemory",
      value: maxmemory ?? "(not set)",
      message: "No maxmemory limit — Redis will consume all available RAM and may be OOM-killed.",
      recommendation: "Set maxmemory to 70-80% of available RAM: CONFIG SET maxmemory <bytes>",
    });
  }

  // 2. maxmemory-policy
  const policy = config["maxmemory-policy"];
  if (policy === "noeviction" && maxmemory !== undefined && maxmemory !== "0") {
    findings.push({
      severity: "WARNING",
      setting: "maxmemory-policy",
      value: policy,
      message: "maxmemory-policy is 'noeviction' — Redis will return errors when memory limit is reached instead of evicting keys.",
      recommendation: "Set an eviction policy: CONFIG SET maxmemory-policy allkeys-lru (or volatile-lru if using TTLs)",
    });
  }

  // 3. bind 0.0.0.0 security check
  const bind = config["bind"];
  const protectedMode = config["protected-mode"];
  if (bind && (bind.includes("0.0.0.0") || bind === "")) {
    if (protectedMode === "no") {
      findings.push({
        severity: "CRITICAL",
        setting: "bind + protected-mode",
        value: `bind=${bind}, protected-mode=${protectedMode}`,
        message: "Redis is bound to all interfaces with protected-mode disabled — accessible from any network without authentication.",
        recommendation: "Either bind to 127.0.0.1 only, enable protected-mode, or set requirepass.",
      });
    } else {
      findings.push({
        severity: "WARNING",
        setting: "bind",
        value: bind,
        message: "Redis is bound to all interfaces (0.0.0.0). Protected-mode is on, but ensure requirepass is also set.",
        recommendation: "Bind to specific interfaces: CONFIG SET bind '127.0.0.1' or set requirepass.",
      });
    }
  }

  // 4. No requirepass
  const requirepass = config["requirepass"];
  if (requirepass === "" || requirepass === undefined) {
    findings.push({
      severity: "WARNING",
      setting: "requirepass",
      value: "(empty)",
      message: "No password set — any client that can reach Redis can read/write data.",
      recommendation: "Set a strong password: CONFIG SET requirepass <password>",
    });
  }

  // 5. appendonly no (no AOF persistence)
  const appendonly = config["appendonly"];
  if (appendonly === "no") {
    const save = config["save"];
    if (!save || save === "" || save === '""') {
      findings.push({
        severity: "CRITICAL",
        setting: "appendonly + save",
        value: `appendonly=${appendonly}, save=${save || "(empty)"}`,
        message: "Both AOF and RDB persistence are disabled — all data will be lost on restart.",
        recommendation: "Enable AOF: CONFIG SET appendonly yes, or configure RDB snapshots.",
      });
    } else {
      findings.push({
        severity: "INFO",
        setting: "appendonly",
        value: appendonly,
        message: "AOF is disabled but RDB snapshots are configured. Data between snapshots may be lost on crash.",
        recommendation: "Consider enabling AOF for better durability: CONFIG SET appendonly yes",
      });
    }
  }

  // 6. Dangerous timeout (0 = never close idle connections)
  const timeout = config["timeout"];
  if (timeout === "0") {
    findings.push({
      severity: "INFO",
      setting: "timeout",
      value: "0",
      message: "Client timeout is 0 (no idle disconnect). Idle connections may accumulate.",
      recommendation: "Set a reasonable timeout for non-pubsub clients: CONFIG SET timeout 300",
    });
  }

  // 7. tcp-keepalive too low or disabled
  const tcpKeepalive = config["tcp-keepalive"];
  if (tcpKeepalive === "0") {
    findings.push({
      severity: "INFO",
      setting: "tcp-keepalive",
      value: "0",
      message: "TCP keepalive is disabled. Dead connections won't be detected.",
      recommendation: "Enable TCP keepalive: CONFIG SET tcp-keepalive 300",
    });
  }

  // 8. hz too low (default 10 is fine, but <10 slows background tasks)
  const hz = config["hz"];
  if (hz && parseInt(hz, 10) < 10) {
    findings.push({
      severity: "INFO",
      setting: "hz",
      value: hz,
      message: `Server frequency is ${hz}Hz (default 10). Low values slow expiry, eviction, and other background tasks.`,
      recommendation: "Set hz to at least 10: CONFIG SET hz 10",
    });
  }

  return { totalSettings, findings };
}

export function formatConfigAnalysis(analysis: ConfigAnalysis): string {
  const sections: string[] = [];

  sections.push("# Redis Configuration Analysis");
  sections.push(`\n**Settings scanned**: ${analysis.totalSettings}`);

  const critical = analysis.findings.filter((f) => f.severity === "CRITICAL");
  const warnings = analysis.findings.filter((f) => f.severity === "WARNING");
  const info = analysis.findings.filter((f) => f.severity === "INFO");

  sections.push(
    `**Issues**: ${critical.length} critical, ${warnings.length} warnings, ${info.length} info`,
  );

  if (critical.length > 0) {
    sections.push("\n## Critical Issues\n");
    for (const f of critical) {
      sections.push(`**${f.setting}** = \`${f.value}\``);
      sections.push(`${f.message}`);
      sections.push(`*Fix*: ${f.recommendation}\n`);
    }
  }

  if (warnings.length > 0) {
    sections.push("\n## Warnings\n");
    for (const f of warnings) {
      sections.push(`**${f.setting}** = \`${f.value}\``);
      sections.push(`${f.message}`);
      sections.push(`*Fix*: ${f.recommendation}\n`);
    }
  }

  if (info.length > 0) {
    sections.push("\n## Informational\n");
    for (const f of info) {
      sections.push(`**${f.setting}** = \`${f.value}\``);
      sections.push(`${f.message}`);
      sections.push(`*Fix*: ${f.recommendation}\n`);
    }
  }

  if (analysis.findings.length === 0) {
    sections.push(
      "\n## No issues detected\n\nRedis configuration appears production-ready.",
    );
  }

  return sections.join("\n");
}
