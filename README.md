[![npm version](https://img.shields.io/npm/v/mcp-redis-diagnostics)](https://www.npmjs.com/package/mcp-redis-diagnostics)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

# MCP Redis Diagnostics

MCP server for Redis diagnostics — analyze memory usage, slowlog, client connections, and keyspace health with AI-powered recommendations.

## Why This Tool?

Most Redis MCP servers are CRUD wrappers (get/set keys). RedisNexus offers diagnostics but targets enterprises (K8s, multi-tenant SaaS). This tool is the only **lightweight npm package** for deep Redis diagnostics — 7 tools covering memory fragmentation, slowlog patterns, client connection health, keyspace distribution, latency analysis, and configuration auditing. Install with `npx`, no Docker or SaaS required.

## Pro Tier

**Generate exportable diagnostic reports (HTML + PDF)** with a Pro license key.

- Full JVM thread dump analysis report with actionable recommendations
- PDF export for sharing with your team
- Priority support

<!-- TODO: replace placeholder Stripe Payment Link once STRIPE_SECRET_KEY is configured -->
**$9.00/month** — [Get Pro License](https://buy.stripe.com/PLACEHOLDER)

Pro license key activates the `generate_report` MCP tool in mcp-jvm-diagnostics.

## Tools (7)

### `analyze_memory`
Analyze Redis memory usage and fragmentation.

**Detects:**
- High memory fragmentation (>1.5x RSS/used ratio)
- Swap risk (fragmentation <1.0)
- Maxmemory pressure (approaching limit)
- Eviction patterns
- Missing maxmemory configuration
- Unsafe noeviction policy

### `analyze_slowlog`
Analyze Redis SLOWLOG for slow commands.

**Parameters:**
- `count` (number, default: 128) — Number of slowlog entries to retrieve

**Detects:**
- Dangerous O(N) commands: KEYS, SMEMBERS, HGETALL, SORT
- High latency commands (>10ms, >100ms thresholds)
- Command concentration patterns
- Full slowlog buffer (missing history)

### `analyze_clients`
Analyze Redis client connections.

**Detects:**
- Blocked clients (BLPOP/BRPOP)
- Connection pool saturation (>80% maxclients)
- Idle connections (>5 minutes)
- Large output buffer memory
- Pub/sub subscriber patterns

### `analyze_keyspace`
Analyze Redis keyspace distribution and cache effectiveness.

**Detects:**
- Low TTL coverage (<20% of keys)
- Low cache hit rate (<80%)
- Unbalanced database distribution
- High expiry/eviction rates
- Multiple database anti-pattern

### `analyze_latency`
Analyze Redis latency events from the LATENCY subsystem.

**Detects:**
- Fork latency spikes (RDB/AOF background save blocking operations)
- AOF fsync delays and write latency
- Slow command processing (O(1) commands unexpectedly slow)
- Eviction and key expiry cycle delays
- Active defragmentation impact
- Increasing latency trends over time

> Requires `latency-monitor-threshold` to be set in redis.conf (e.g., `CONFIG SET latency-monitor-threshold 100`).

### `analyze_config`
Analyze Redis configuration for security and reliability risks.

**Detects:**
- No maxmemory limit (unbounded memory growth, OOM risk)
- Unsafe eviction policy (noeviction causing errors at memory limit)
- Network exposure (bind 0.0.0.0 without protected-mode)
- Missing authentication (no requirepass)
- Disabled persistence (both AOF and RDB off — data loss on restart)
- Idle connection accumulation (timeout 0)
- Disabled TCP keepalive (dead connections undetected)
- Low server frequency (hz < 10 slowing background tasks)

### `analyze_performance`
Comprehensive health assessment — runs all analyzers and produces a unified report.

**Parameters:**
- `slowlog_count` (number, default: 128) — Number of slowlog entries

## Installation

```bash
npm install -g mcp-redis-diagnostics
```

Or run directly:

```bash
npx mcp-redis-diagnostics
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "redis-diagnostics": {
      "command": "npx",
      "args": ["-y", "mcp-redis-diagnostics"],
      "env": {
        "REDIS_URL": "redis://localhost:6379"
      }
    }
  }
}
```

### Redis with password:

```json
{
  "env": {
    "REDIS_URL": "redis://:yourpassword@localhost:6379"
  }
}
```

## Quick Demo

Once configured, try these prompts in Claude:

1. **"Analyze my Redis memory usage — is there fragmentation?"** — Shows used vs max memory, fragmentation ratio, eviction policy, and memory pressure issues
2. **"Check the Redis slowlog for dangerous commands"** — Identifies O(N) commands like KEYS/SMEMBERS, high-latency patterns, and optimization suggestions
3. **"Run a complete Redis health check"** — Unified report combining memory, slowlog, clients, keyspace, and latency analysis

> "What's my cache hit rate? Are my TTLs configured properly?"

> "Give me a full Redis health check"

## Part of the MCP Java Backend Suite

This tool is part of a suite of MCP servers for backend developers:

- **mcp-db-analyzer** — PostgreSQL/MySQL/SQLite schema analysis
- **mcp-jvm-diagnostics** — Thread dump and GC log analysis
- **mcp-migration-advisor** — Flyway/Liquibase migration risk analysis
- **mcp-spring-boot-actuator** — Spring Boot health and metrics analysis
- **mcp-redis-diagnostics** — Redis memory, slowlog, and client diagnostics

## Limitations & Known Issues

- **Single Redis instance**: Analyzes one Redis instance at a time. Does not support Redis Cluster topology discovery or Sentinel failover analysis.
- **ACL restrictions**: Some tools require specific Redis commands (SLOWLOG, CLIENT LIST, LATENCY). Redis ACLs may block these. The `analyze_performance` unified tool handles partial failures gracefully.
- **Latency monitoring**: The `analyze_latency` tool requires `latency-monitor-threshold` to be set in redis.conf. Without it, no latency events are captured.
- **Key-level analysis**: Keyspace analysis uses `INFO keyspace` aggregates. Individual key inspection (e.g., finding the largest keys) requires `MEMORY USAGE` per key, which is not performed to avoid impacting production.
- **Redis Cluster**: No cluster-specific analysis (slot distribution, rebalancing, cross-node latency). Works against individual nodes only.
- **Redis Modules**: Module-specific commands and data types (RedisJSON, RediSearch, RedisTimeSeries) are not analyzed.
- **Memory advisor**: Memory recommendations are based on `INFO memory` stats. For detailed memory breakdown by key type, use `redis-cli --bigkeys` externally.
- **Fragmentation ratio**: Memory fragmentation uses RSS vs. used memory ratio, which can be distorted by jemalloc. Values <1.0 may not always indicate swapping.
- **Read-only**: All commands are read-only (INFO, SLOWLOG GET, CLIENT LIST, LATENCY). No data or configuration is modified.

## License

MIT
