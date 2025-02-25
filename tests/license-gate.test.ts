import { describe, it, expect } from "vitest";
import { validateLicense, formatUpgradePrompt } from "../src/license.js";

describe("Redis Diagnostics license validation", () => {
  it("returns free mode when no key", () => {
    const result = validateLicense(undefined, "redis-diagnostics");
    expect(result.isPro).toBe(false);
    expect(result.reason).toBe("No license key provided");
  });

  it("returns free mode for empty string", () => {
    expect(validateLicense("", "redis-diagnostics").isPro).toBe(false);
  });

  it("returns free mode for invalid key", () => {
    expect(validateLicense("MCPJBS-AAAAA-AAAAA-AAAAA-AAAAA", "redis-diagnostics").isPro).toBe(false);
  });

  it("returns free mode for wrong prefix", () => {
    const result = validateLicense("WRONG-AAAAA-AAAAA-AAAAA-AAAAA", "redis-diagnostics");
    expect(result.reason).toContain("missing MCPJBS- prefix");
  });
});

describe("Redis upgrade prompts", () => {
  const proTools = [
    ["analyze_clients", "Client connection analysis"],
    ["analyze_latency", "Latency event analysis"],
  ] as const;

  for (const [tool, desc] of proTools) {
    it(`${tool} prompt includes tool name and pricing`, () => {
      const prompt = formatUpgradePrompt(tool, desc);
      expect(prompt).toContain(`${tool} (Pro Feature)`);
      expect(prompt).toContain("MCP_LICENSE_KEY");
      expect(prompt).toContain("mcpjbs.dev/pricing");
    });
  }
});
