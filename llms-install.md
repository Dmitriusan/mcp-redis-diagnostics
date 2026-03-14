# Install mcp-redis-diagnostics via Cline

Run in Cline terminal:

```bash
npx -y mcp-redis-diagnostics
```

# Configuration

| Env var | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `REDIS_PASSWORD` | (none) | Redis AUTH password if required |

Add to your MCP client config:

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
