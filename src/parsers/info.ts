/**
 * Redis INFO command parser.
 * Parses the multi-section output of INFO ALL into structured data.
 */

export interface RedisInfo {
  server: Record<string, string>;
  clients: Record<string, string>;
  memory: Record<string, string>;
  stats: Record<string, string>;
  replication: Record<string, string>;
  cpu: Record<string, string>;
  keyspace: Record<string, string>;
  [section: string]: Record<string, string>;
}

export interface KeyspaceDB {
  db: string;
  keys: number;
  expires: number;
  avgTtl: number;
}

/**
 * Parse raw Redis INFO output into structured sections.
 */
export function parseRedisInfo(raw: string): RedisInfo {
  const info: RedisInfo = {
    server: {},
    clients: {},
    memory: {},
    stats: {},
    replication: {},
    cpu: {},
    keyspace: {},
  };

  let currentSection = "";
  const lines = raw.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      // Section header like "# Server"
      const match = trimmed.match(/^#\s*(.+)/);
      if (match) {
        currentSection = match[1].toLowerCase();
        if (!info[currentSection]) {
          info[currentSection] = {};
        }
      }
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.substring(0, colonIdx);
    const value = trimmed.substring(colonIdx + 1);

    if (currentSection && info[currentSection]) {
      info[currentSection][key] = value;
    }
  }

  return info;
}

/**
 * Parse keyspace entries like "db0:keys=100,expires=50,avg_ttl=30000"
 */
export function parseKeyspaceEntries(info: RedisInfo): KeyspaceDB[] {
  const entries: KeyspaceDB[] = [];

  for (const [key, value] of Object.entries(info.keyspace)) {
    if (!key.startsWith("db")) continue;

    const parts: Record<string, string> = {};
    for (const pair of value.split(",")) {
      const [k, v] = pair.split("=");
      if (k && v) parts[k] = v;
    }

    entries.push({
      db: key,
      keys: parseInt(parts.keys || "0", 10),
      expires: parseInt(parts.expires || "0", 10),
      avgTtl: parseInt(parts.avg_ttl || "0", 10),
    });
  }

  return entries;
}

/**
 * Extract a numeric value from INFO, defaulting to 0.
 */
export function infoNum(info: RedisInfo, section: string, key: string): number {
  const val = info[section]?.[key];
  if (val === undefined) return 0;
  return parseFloat(val) || 0;
}

/**
 * Extract a string value from INFO.
 */
export function infoStr(info: RedisInfo, section: string, key: string): string {
  return info[section]?.[key] ?? "";
}

/**
 * Format bytes into human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024));
  const idx = Math.min(i, units.length - 1);
  return `${(bytes / Math.pow(1024, idx)).toFixed(1)} ${units[idx]}`;
}
