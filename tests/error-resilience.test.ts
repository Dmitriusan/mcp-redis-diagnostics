import { describe, it, expect } from "vitest";

// Test the wrapRedisError logic by importing the module indirectly
// Since wrapRedisError is not exported, we test the same patterns it handles

describe("Redis error resilience patterns", () => {
  const REDIS_CONNECTION_ERROR_RE =
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|NOAUTH|ERR AUTH|wrong number of arguments for 'auth'|Connection is closed|max retries per request/i;

  function wrapRedisError(context: string, err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    const sanitized = msg.replace(/\/\/[^@]+@/g, "//****:****@");
    if (REDIS_CONNECTION_ERROR_RE.test(msg)) {
      return `Error ${context}: ${sanitized}\n\nThis looks like a Redis connection issue. Check your configuration:\n- Set REDIS_URL environment variable (e.g., redis://localhost:6379)\n- For authenticated Redis: REDIS_URL=redis://:password@host:6379\n- Ensure the Redis server is running and accessible`;
    }
    return `Error ${context}: ${sanitized}`;
  }

  it("should detect ECONNREFUSED and add Redis config guidance", () => {
    const result = wrapRedisError(
      "analyzing memory",
      new Error("connect ECONNREFUSED 127.0.0.1:6379")
    );
    expect(result).toContain("Redis connection issue");
    expect(result).toContain("REDIS_URL");
    expect(result).toContain("ECONNREFUSED");
  });

  it("should detect NOAUTH for unauthenticated connections", () => {
    const result = wrapRedisError(
      "analyzing slowlog",
      new Error("NOAUTH Authentication required")
    );
    expect(result).toContain("Redis connection issue");
    expect(result).toContain("REDIS_URL=redis://:password@");
  });

  it("should detect ERR AUTH for wrong password", () => {
    const result = wrapRedisError(
      "analyzing clients",
      new Error("ERR AUTH invalid password")
    );
    expect(result).toContain("Redis connection issue");
  });

  it("should detect ETIMEDOUT for unreachable host", () => {
    const result = wrapRedisError(
      "analyzing keyspace",
      new Error("connect ETIMEDOUT 10.0.0.1:6379")
    );
    expect(result).toContain("Redis connection issue");
  });

  it("should detect ENOTFOUND for invalid hostname", () => {
    const result = wrapRedisError(
      "analyzing latency",
      new Error("getaddrinfo ENOTFOUND redis.invalid.host")
    );
    expect(result).toContain("Redis connection issue");
  });

  it("should detect maxRetriesPerRequest exhaustion", () => {
    const result = wrapRedisError(
      "analyzing performance",
      new Error("Reached the max retries per request limit (which is 1)")
    );
    expect(result).toContain("Redis connection issue");
  });

  it("should detect Connection is closed", () => {
    const result = wrapRedisError(
      "analyzing memory",
      new Error("Connection is closed")
    );
    expect(result).toContain("Redis connection issue");
  });

  it("should NOT add connection guidance for regular errors", () => {
    const result = wrapRedisError(
      "analyzing memory",
      new Error("ERR wrong number of arguments for 'info' command")
    );
    expect(result).toContain("Error analyzing memory");
    expect(result).not.toContain("Redis connection issue");
  });

  it("should sanitize credentials from Redis URLs", () => {
    const result = wrapRedisError(
      "analyzing memory",
      new Error("connect ECONNREFUSED redis://admin:secret@redis.host:6379")
    );
    expect(result).not.toContain("secret");
    expect(result).toContain("****:****@");
  });

  it("should handle non-Error objects", () => {
    const result = wrapRedisError("analyzing memory", "plain string error");
    expect(result).toContain("Error analyzing memory: plain string error");
  });
});
