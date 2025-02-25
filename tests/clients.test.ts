import { describe, it, expect } from "vitest";
import { parseRedisInfo } from "../src/parsers/info.js";
import { parseClientList, analyzeClients, formatClientAnalysis } from "../src/analyzers/clients.js";

const SAMPLE_CLIENT_LIST = `id=1 addr=127.0.0.1:50000 fd=5 name=app1 age=100 idle=5 flags=N db=0 cmd=get qbuf=0 qbuf-free=32768 obl=0 oll=0 omem=0
id=2 addr=127.0.0.1:50001 fd=6 name=worker age=3600 idle=600 flags=N db=0 cmd=idle qbuf=0 qbuf-free=0 obl=0 oll=0 omem=0
id=3 addr=127.0.0.1:50002 fd=7 name=blocker age=200 idle=100 flags=b db=0 cmd=blpop qbuf=0 qbuf-free=32768 obl=0 oll=0 omem=0
id=4 addr=127.0.0.1:50003 fd=8 name=bigbuf age=50 idle=2 flags=N db=0 cmd=subscribe qbuf=0 qbuf-free=0 obl=0 oll=100 omem=2097152`;

function makeInfo(overrides: Record<string, Record<string, string>> = {}) {
  const base = `# Clients
connected_clients:${overrides.clients?.connected_clients || "42"}
blocked_clients:${overrides.clients?.blocked_clients || "1"}

# Server
maxclients:${overrides.server?.maxclients || "10000"}
`;
  return parseRedisInfo(base);
}

describe("parseClientList", () => {
  it("parses CLIENT LIST output", () => {
    const clients = parseClientList(SAMPLE_CLIENT_LIST);
    expect(clients).toHaveLength(4);
    expect(clients[0].id).toBe("1");
    expect(clients[0].addr).toBe("127.0.0.1:50000");
    expect(clients[0].name).toBe("app1");
    expect(clients[0].age).toBe(100);
    expect(clients[0].idle).toBe(5);
    expect(clients[0].cmd).toBe("get");
  });

  it("handles empty input", () => {
    expect(parseClientList("")).toHaveLength(0);
    expect(parseClientList("  \n  ")).toHaveLength(0);
  });

  it("parses blocked client flags", () => {
    const clients = parseClientList(SAMPLE_CLIENT_LIST);
    const blocker = clients.find((c) => c.name === "blocker");
    expect(blocker!.flags).toBe("b");
    expect(blocker!.cmd).toBe("blpop");
  });

  it("parses output memory", () => {
    const clients = parseClientList(SAMPLE_CLIENT_LIST);
    const bigbuf = clients.find((c) => c.name === "bigbuf");
    expect(bigbuf!.omem).toBe(2097152);
    expect(bigbuf!.oll).toBe(100);
  });
});

describe("analyzeClients", () => {
  it("detects blocked clients", () => {
    const clients = parseClientList(SAMPLE_CLIENT_LIST);
    const info = makeInfo({ clients: { connected_clients: "42", blocked_clients: "5" } });
    const analysis = analyzeClients(clients, info);
    const blocked = analysis.findings.find((f) => f.title.includes("blocked"));
    expect(blocked).toBeDefined();
  });

  it("detects connection saturation >80%", () => {
    const clients = parseClientList(SAMPLE_CLIENT_LIST);
    const info = makeInfo({
      clients: { connected_clients: "8500", blocked_clients: "0" },
      server: { maxclients: "10000" },
    });
    const analysis = analyzeClients(clients, info);
    const saturation = analysis.findings.find((f) => f.title.includes("85.0%"));
    expect(saturation).toBeDefined();
    expect(saturation!.severity).toBe("WARNING");
  });

  it("detects critical connection saturation >95%", () => {
    const clients = parseClientList(SAMPLE_CLIENT_LIST);
    const info = makeInfo({
      clients: { connected_clients: "9800", blocked_clients: "0" },
      server: { maxclients: "10000" },
    });
    const analysis = analyzeClients(clients, info);
    const saturation = analysis.findings.find((f) => f.title.includes("98.0%"));
    expect(saturation!.severity).toBe("CRITICAL");
  });

  it("detects idle connections", () => {
    const clients = parseClientList(SAMPLE_CLIENT_LIST);
    const info = makeInfo({ clients: { connected_clients: "4", blocked_clients: "0" } });
    const analysis = analyzeClients(clients, info);
    // client id=2 has idle=600 which is > 300
    expect(analysis.idleConnections).toBe(1);
  });

  it("detects large output buffers", () => {
    const clients = parseClientList(SAMPLE_CLIENT_LIST);
    const info = makeInfo({ clients: { connected_clients: "4", blocked_clients: "0" } });
    const analysis = analyzeClients(clients, info);
    const bufFinding = analysis.findings.find((f) => f.title.includes("output buffers"));
    expect(bufFinding).toBeDefined();
  });

  it("reports healthy state when no issues", () => {
    const clients = parseClientList(
      "id=1 addr=127.0.0.1:5000 fd=5 name=app age=10 idle=1 flags=N db=0 cmd=get qbuf=0 qbuf-free=32768 obl=0 oll=0 omem=0"
    );
    const info = makeInfo({ clients: { connected_clients: "1", blocked_clients: "0" } });
    const analysis = analyzeClients(clients, info);
    expect(analysis.summary).toContain("OK");
  });

  it("formatClientAnalysis produces readable output", () => {
    const clients = parseClientList(SAMPLE_CLIENT_LIST);
    const info = makeInfo();
    const analysis = analyzeClients(clients, info);
    const output = formatClientAnalysis(analysis);
    expect(output).toContain("# Redis Client Analysis");
    expect(output).toContain("Connected Clients:");
    expect(output).toContain("Blocked Clients:");
  });
});
