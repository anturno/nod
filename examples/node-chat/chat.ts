/** A readline chat over one nod agent: type, watch the reply stream, `/exit` to quit. */
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { createAgent } from "../../src/sdk/index.ts";

const provider = process.env.NOD_PROVIDER === "grok" ? "grok" : "codex";
const agent = await createAgent({
  auth: { provider },
  model: process.env.NOD_MODEL,
  instructions: "Keep answers concise.",
  workspace: { cwd: process.cwd(), shell: false },
});
const input = createInterface({ input: stdin, output: stdout, prompt: "You: " });

try {
  input.prompt();
  for await (const line of input) {
    if (line.trim() === "/exit") break;
    if (!line.trim()) {
      input.prompt();
      continue;
    }
    stdout.write("Agent: ");
    const turn = agent.prompt(line);
    for await (const event of turn) {
      if (event.type === "text_delta") stdout.write(event.delta);
    }
    await turn.result;
    stdout.write("\n\n");
    input.prompt();
  }
} finally {
  input.close();
  await agent.close();
}
