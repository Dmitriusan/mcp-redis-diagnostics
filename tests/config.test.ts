import { describe, it, expect } from "vitest";
import { analyzeConfig, formatConfigAnalysis } from "../src/analyzers/config.js";

function makeConfig(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    maxmemory: "1073741824",
    "maxmemory-policy": "allkeys-lru",
    bind: "127.0.0.1",
    "protected-mode": "yes",
    requirepass: "s3cret",
    appendonly: "yes",
    save: "3600 1 300 100 60 10000",
    timeout: "300",
    "tcp-keepalive": "300",
    hz: "10",
    ...overrides,
  };
}

describe("analyzeConfig — no maxmemory", () => {
  it("should flag maxmemory 0 as CRITICAL", () => {
    const result = analyzeConfig(makeConfig({ maxmemory: "0" }));
    const finding = result.findings.find((f) => f.setting === "maxmemory");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("CRITICAL");
    expect(finding!.message).toContain("OOM");
  });

  it("should flag missing maxmemory as CRITICAL", () => {
    const config = makeConfig();
    delete config.maxmemory;
    const result = analyzeConfig(config);
    expect(result.findings.some((f) => f.setting === "maxmemory" && f.severity === "CRITICAL")).toBe(true);
  });
});

describe("analyzeConfig — maxmemory-policy", () => {
  it("should flag noeviction policy as WARNING when maxmemory is set", () => {
    const result = analyzeConfig(makeConfig({ "maxmemory-policy": "noeviction" }));
    const finding = result.findings.find((f) => f.setting === "maxmemory-policy");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
  });

  it("should not flag noeviction when maxmemory is 0 (no limit anyway)", () => {
    const result = analyzeConfig(makeConfig({ maxmemory: "0", "maxmemory-policy": "noeviction" }));
    const finding = result.findings.find((f) => f.setting === "maxmemory-policy");
    expect(finding).toBeUndefined();
  });
});

describe("analyzeConfig — network security", () => {
  it("should flag bind 0.0.0.0 + protected-mode no as CRITICAL", () => {
    const result = analyzeConfig(makeConfig({
      bind: "0.0.0.0",
      "protected-mode": "no",
    }));
    const finding = result.findings.find((f) => f.severity === "CRITICAL" && f.setting.includes("bind"));
    expect(finding).toBeDefined();
    expect(finding!.message).toContain("accessible from any network");
  });

  it("should flag bind 0.0.0.0 with protected-mode yes as WARNING", () => {
    const result = analyzeConfig(makeConfig({
      bind: "0.0.0.0",
      "protected-mode": "yes",
    }));
    const finding = result.findings.find((f) => f.setting === "bind");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
  });

  it("should not flag bind 127.0.0.1", () => {
    const result = analyzeConfig(makeConfig({ bind: "127.0.0.1" }));
    const bindFindings = result.findings.filter((f) => f.setting.includes("bind"));
    expect(bindFindings.length).toBe(0);
  });

  it("should flag empty bind string + protected-mode no as CRITICAL", () => {
    // Empty bind means Redis has no explicit bind directive → listens on all interfaces.
    // Previously the `bind &&` guard silently skipped the empty-string case.
    const result = analyzeConfig(makeConfig({ bind: "", "protected-mode": "no" }));
    const finding = result.findings.find((f) => f.severity === "CRITICAL" && f.setting.includes("bind"));
    expect(finding).toBeDefined();
    expect(finding!.message).toContain("accessible from any network");
  });

  it("should flag empty bind string + protected-mode yes as WARNING", () => {
    const result = analyzeConfig(makeConfig({ bind: "", "protected-mode": "yes" }));
    const finding = result.findings.find((f) => f.setting === "bind");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
  });
});

describe("analyzeConfig — authentication", () => {
  it("should flag empty requirepass as WARNING", () => {
    const result = analyzeConfig(makeConfig({ requirepass: "" }));
    const finding = result.findings.find((f) => f.setting === "requirepass");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARNING");
  });
});

describe("analyzeConfig — persistence", () => {
  it("should flag both AOF and RDB disabled as CRITICAL", () => {
    const result = analyzeConfig(makeConfig({ appendonly: "no", save: "" }));
    const finding = result.findings.find((f) => f.setting === "appendonly + save");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("CRITICAL");
  });

  it("should flag AOF off with RDB on as INFO", () => {
    const result = analyzeConfig(makeConfig({ appendonly: "no" }));
    const finding = result.findings.find((f) => f.setting === "appendonly");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("INFO");
  });

  it("should not flag when AOF is enabled", () => {
    const result = analyzeConfig(makeConfig({ appendonly: "yes" }));
    const aofFindings = result.findings.filter((f) => f.setting.includes("appendonly"));
    expect(aofFindings.length).toBe(0);
  });
});

describe("analyzeConfig — healthy configuration", () => {
  it("should report zero findings for a hardened config", () => {
    const result = analyzeConfig(makeConfig());
    expect(result.findings.length).toBe(0);
  });

  it("should return total settings count", () => {
    const config = makeConfig();
    const result = analyzeConfig(config);
    expect(result.totalSettings).toBe(Object.keys(config).length);
  });
});

describe("analyzeConfig — connection tuning", () => {
  it("should flag timeout 0 as INFO", () => {
    const result = analyzeConfig(makeConfig({ timeout: "0" }));
    const finding = result.findings.find((f) => f.setting === "timeout");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("INFO");
    expect(finding!.message).toContain("idle");
  });

  it("should not flag timeout > 0", () => {
    const result = analyzeConfig(makeConfig({ timeout: "300" }));
    const finding = result.findings.find((f) => f.setting === "timeout");
    expect(finding).toBeUndefined();
  });

  it("should flag tcp-keepalive 0 as INFO", () => {
    const result = analyzeConfig(makeConfig({ "tcp-keepalive": "0" }));
    const finding = result.findings.find((f) => f.setting === "tcp-keepalive");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("INFO");
    expect(finding!.message).toContain("keepalive");
  });

  it("should not flag tcp-keepalive > 0", () => {
    const result = analyzeConfig(makeConfig({ "tcp-keepalive": "60" }));
    const finding = result.findings.find((f) => f.setting === "tcp-keepalive");
    expect(finding).toBeUndefined();
  });

  it("should flag hz below 10 as INFO", () => {
    const result = analyzeConfig(makeConfig({ hz: "5" }));
    const finding = result.findings.find((f) => f.setting === "hz");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("INFO");
    expect(finding!.value).toBe("5");
    expect(finding!.recommendation).toContain("CONFIG SET hz 10");
  });

  it("should not flag hz at 10 or above", () => {
    const result = analyzeConfig(makeConfig({ hz: "10" }));
    const finding = result.findings.find((f) => f.setting === "hz");
    expect(finding).toBeUndefined();
  });
});

describe("formatConfigAnalysis", () => {
  it("should format findings grouped by severity", () => {
    const result = analyzeConfig(makeConfig({ maxmemory: "0", requirepass: "" }));
    const formatted = formatConfigAnalysis(result);
    expect(formatted).toContain("# Redis Configuration Analysis");
    expect(formatted).toContain("## Critical Issues");
    expect(formatted).toContain("## Warnings");
    expect(formatted).toContain("maxmemory");
  });

  it("should show no issues for clean config", () => {
    const result = analyzeConfig(makeConfig());
    const formatted = formatConfigAnalysis(result);
    expect(formatted).toContain("# Redis Configuration Analysis");
    expect(formatted).toContain("No issues detected");
  });
});
