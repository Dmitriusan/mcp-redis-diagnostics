# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.8] - 2026-04-02

### Fixed
- Slowlog command concentration warning now fires for slowlogs with 2–5 entries. Previously the `entries.length > 5` guard silently skipped the check — if SORT dominated 3 of 3 entries (100%), no warning was produced.

### Added
- Tests for `active-defrag-cycle` latency detection and the generic unrecognized-event handler, which previously had no coverage.

### Changed
- `analyze_slowlog` tool description now lists all 7 detected dangerous commands (KEYS, SMEMBERS, HGETALL, LRANGE, SORT, FLUSHDB, FLUSHALL) and their safer alternatives.

## [0.1.0] - 2026-03-10

### Added
- Initial release
- `analyze_memory` tool — Redis memory diagnostics with fragmentation, eviction risk, and maxmemory analysis
- `analyze_slowlog` tool — Slow command detection with frequency analysis and optimization recommendations
- `analyze_clients` tool — Client connection analysis with blocked client detection and idle connection warnings
- `analyze_keyspace` tool — Keyspace distribution analysis with TTL coverage and expiry rate monitoring
- `analyze_performance` tool — Unified Redis health assessment combining all analyzers
- Redis INFO parser for server, clients, memory, stats, and keyspace sections
- Support for Redis connection via REDIS_URL environment variable
