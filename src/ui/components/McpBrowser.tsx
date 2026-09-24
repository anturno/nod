/** `/mcp`: a stub until the MCP runtime lands; lists nothing and points at `nod mcp add`. */
import { Text } from "ink";
import { Menu } from "./Menu.tsx";

// ponytail: replace with the server/tool/resource/prompt browser once createMcpRuntime is wired into the runtime.
export function McpBrowser() {
  return (
    <Menu
      title="MCP servers"
      index={0}
      rows={[]}
      empty="no MCP servers configured · nod mcp add NAME COMMAND"
      footer={<Text dimColor>esc close</Text>}
    />
  );
}
