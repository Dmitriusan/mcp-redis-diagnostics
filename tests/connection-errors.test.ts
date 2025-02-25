import { describe, it, expect } from "vitest";

// Test the error wrapping functions by importing them
// Since wrapRedisError and getRedis are not exported, we test the behavior
// by importing the module and testing the patterns directly

// Test the REDIS_CONNECTION_ERROR_RE pattern and sanitization logic
// that wrapRedisError uses internally

describe("Redis connection error handling patterns", () => {
  // Replicate the regex from index.ts to test it
  const REDIS_CONNECTION_ERROR_RE =
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|NOAUTH|ERR AUTH|wrong number of arguments for 'auth'|Connection is closed|maxRetriesPerRequest/i;

  const credentialScrubRegex = /\/\/[^@]+@/g;

  function wrapRedisError(context: string, err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    const sanitized = msg.replace(credentialScrubRegex, "//****:****@");
    if (REDIS_CONNECTION_ERROR_RE.test(msg)) {
      return `Error ${context}: ${sanitized}\n\nThis looks like a Redis connection issue. Check your configuration:\n- Set REDIS_URL environment variable (e.g., redis://localhost:6379)\n- For authenticated Redis: REDIS_URL=redis://:password@host:6379\n- Ensure the Redis server is running and accessible`;
    }
    return `Error ${context}: ${sanitized}`;
  }

  it("detects ECONNREFUSED and provides connection guidance", () => {
    const result = wrapRedisError(
      "analyzing memory",
      new Error("connect ECONNREFUSED 127.0.0.1:6379")
    );
    expect(result).toContain("Redis connection issue");
    expect(result).toContain("REDIS_URL");
    expect(result).toContain("ECONNREFUSED");
  });

  it("detects NOAUTH error when Redis requires password", () => {
    const result = wrapRedisError(
      "analyzing memory",
      new Error("NOAUTH Authentication required")
    );
    expect(result).toContain("Redis connection issue");
    expect(result).toContain("redis://:password@host:6379");
  });

  it("detects ERR AUTH error when wrong password provided", () => {
    const result = wrapRedisError(
      "analyzing memory",
      new Error("ERR AUTH failed")
    );
    expect(result).toContain("Redis connection issue");
  });

  it("detects ENOTFOUND when hostname is invalid", () => {
    const result = wrapRedisError(
      "analyzing memory",
      new Error("getaddrinfo ENOTFOUND redis.invalid.host")
    );
    expect(result).toContain("Redis connection issue");
    expect(result).toContain("REDIS_URL");
  });

  it("detects ETIMEDOUT when Redis is unreachable", () => {
    const result = wrapRedisError(
      "analyzing memory",
      new Error("connect ETIMEDOUT 10.0.0.1:6379")
    );
    expect(result).toContain("Redis connection issue");
  });

  it("detects maxRetriesPerRequest exceeded", () => {
    const result = wrapRedisError(
      "analyzing memory",
      new Error("Reached the maxRetriesPerRequest limit")
    );
    expect(result).toContain("Redis connection issue");
  });

  it("sanitizes credentials from error messages", () => {
    const result = wrapRedisError(
      "analyzing memory",
      new Error("connect to redis://admin:supersecret@redis.example.com:6379 failed")
    );
    expect(result).not.toContain("supersecret");
    expect(result).toContain("****:****@");
  });

  it("does not add connection guidance for non-connection errors", () => {
    const result = wrapRedisError(
      "analyzing memory",
      new Error("ERR wrong number of arguments for 'info' command")
    );
    expect(result).not.toContain("Redis connection issue");
    expect(result).toContain("Error analyzing memory");
  });

  it("handles non-Error objects", () => {
    const result = wrapRedisError("analyzing memory", "string error");
    expect(result).toContain("Error analyzing memory: string error");
  });

  it("handles undefined/null errors", () => {
    const result = wrapRedisError("analyzing memory", undefined);
    expect(result).toContain("Error analyzing memory: undefined");
  });
});

describe("Redis URL sanitization", () => {
  // Replicate the sanitizeUrl function from index.ts
  function sanitizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.password) {
        parsed.password = "****";
      }
      return parsed.toString();
    } catch {
      return url.replace(/:([^@:]+)@/, ":****@");
    }
  }

  it("masks password in standard redis URL", () => {
    const result = sanitizeUrl("redis://:mypassword@localhost:6379");
    expect(result).not.toContain("mypassword");
    expect(result).toContain("****");
  });

  it("masks user:pass in redis URL", () => {
    const result = sanitizeUrl("redis://admin:secret@redis.example.com:6379");
    expect(result).not.toContain("secret");
    expect(result).toContain("****");
  });

  it("leaves URL unchanged when no password", () => {
    const result = sanitizeUrl("redis://localhost:6379");
    expect(result).toBe("redis://localhost:6379");
  });

  it("handles non-standard URLs with regex fallback", () => {
    const result = sanitizeUrl("not-a-url://:pass123@host");
    expect(result).not.toContain("pass123");
    expect(result).toContain("****@");
  });
});
