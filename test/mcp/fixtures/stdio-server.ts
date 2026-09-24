/** A tiny NDJSON MCP server for tests. Env: MCP_FIXTURE_VERSION, MCP_FIXTURE_IGNORE_TERM, MCP_FIXTURE_CRASH_ON_CALL. */
const version = process.env.MCP_FIXTURE_VERSION ?? "2025-11-25";
if (process.env.MCP_FIXTURE_IGNORE_TERM) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000); // keep the event loop alive after stdin closes
}
const write = (m: object) => process.stdout.write(`${JSON.stringify(m)}\n`);
const tools = [
  {
    name: "echo",
    description: "Echo text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  { name: "bad", description: "not an object schema", inputSchema: { type: "string" } },
];
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl = buffer.indexOf("\n");
  while (nl >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf("\n");
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") {
      if (m.params.protocolVersion !== version && process.env.MCP_FIXTURE_STRICT)
        write({
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32022, message: "unsupported", data: { supported: [version] } },
        });
      else
        write({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            protocolVersion: version,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fixture", version: "1" },
            instructions: "Fixture instructions",
          },
        });
    } else if (m.method === "tools/list") write({ jsonrpc: "2.0", id: m.id, result: { tools } });
    else if (m.method === "tools/call") {
      if (process.env.MCP_FIXTURE_CRASH_ON_CALL) process.exit(3);
      process.stderr.write("handling call\n");
      write({
        jsonrpc: "2.0",
        id: m.id,
        result: { content: [{ type: "text", text: `echo:${m.params.arguments?.text ?? ""}` }] },
      });
    } else if (m.method === "ping") write({ jsonrpc: "2.0", id: m.id, result: {} });
    else if (m.id !== undefined)
      write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
  }
});
process.stdin.on("end", () => {
  if (!process.env.MCP_FIXTURE_IGNORE_TERM) process.exit(0);
});
