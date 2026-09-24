/**
 * The eval tasks. Each is a tiny repository, a prompt, and a check of the finished workspace and what the agent said.
 * `reference` is a known-good solution: test/evals.test.ts proves every check fails on the fixture and passes with it.
 */
export type Exec = (command: string) => Promise<{ output: string; exitCode: number | null }>;
/** `answer` is everything the agent said, as the user saw it. */
export type Workspace = { exec: Exec; answer: string };
export type Task = {
  name: string;
  /** What the task exercises, for the report. */
  skill: string;
  prompt: string;
  files: Record<string, string>;
  check: (ws: Workspace) => Promise<boolean>;
  reference: { command?: string; answer?: string };
};

const succeeds =
  (command: string) =>
  async ({ exec }: Workspace) =>
    (await exec(command)).exitCode === 0;
/** Tests may not be edited to make them pass. */
const unchanged =
  (path: string, content: string) =>
  async ({ exec }: Workspace) =>
    (await exec(`cat ${path}`)).output === content.trim();
const both =
  (...checks: Task["check"][]) =>
  async (ws: Workspace) => {
    for (const check of checks) if (!(await check(ws))) return false;
    return true;
  };
const answers =
  (pattern: RegExp) =>
  async ({ answer }: Workspace) =>
    pattern.test(answer);

const rangeTest = `import { expect, test } from "bun:test";
import { range } from "./src/range.ts";

test("range is inclusive", () => {
  expect(range(1, 3)).toEqual([1, 2, 3]);
  expect(range(5, 5)).toEqual([5]);
});
`;

const slugTest = `import { expect, test } from "bun:test";
import { slugify } from "./src/slug.ts";

test("slugify", () => {
  expect(slugify("Hello, World!")).toBe("hello-world");
  expect(slugify("  Multiple   spaces ")).toBe("multiple-spaces");
  expect(slugify("Crème Brûlée")).toBe("creme-brulee");
  expect(slugify("a--b__c")).toBe("a-b-c");
});
`;

const todos = {
  "src/a.ts": "// TODO: validate input\nexport const a = 1;\n// TODO: remove\n",
  "src/b.ts": "export const b = 2; // TODO: rename\n",
  "src/c.ts": "export const note = 'not a comment';\n",
};

export const TASKS: Task[] = [
  {
    name: "fix-bug",
    skill: "debug a failing test",
    prompt: "The test in range.test.ts fails. Fix the bug in src/range.ts.",
    files: {
      "src/range.ts":
        "export const range = (start: number, end: number) => Array.from({ length: end - start }, (_, i) => start + i);\n",
      "range.test.ts": rangeTest,
    },
    check: both(succeeds("bun test"), unchanged("range.test.ts", rangeTest)),
    reference: { command: "sed -i.bak 's/end - start/end - start + 1/' src/range.ts && rm src/range.ts.bak" },
  },
  {
    name: "implement",
    skill: "write a function to a spec",
    prompt: "Implement slugify in src/slug.ts so that slug.test.ts passes.",
    files: {
      "src/slug.ts": 'export function slugify(text: string): string {\n  throw new Error("not implemented");\n}\n',
      "slug.test.ts": slugTest,
    },
    check: both(succeeds("bun test"), unchanged("slug.test.ts", slugTest)),
    reference: {
      command: String.raw`cat > src/slug.ts <<'EOF'
export const slugify = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
EOF`,
    },
  },
  {
    name: "rename",
    skill: "refactor across files",
    prompt: "Rename the function getUser to fetchUser everywhere in this project.",
    files: {
      "src/users.ts": "export function getUser(id: number) {\n  return { id, name: `user${id}` };\n}\n",
      "src/api.ts":
        'import { getUser } from "./users.ts";\n\nexport const handler = (id: number) => getUser(id).name;\nexport const both = (a: number, b: number) => [getUser(a), getUser(b)];\n',
      "api.test.ts":
        'import { expect, test } from "bun:test";\nimport { handler } from "./src/api.ts";\n\ntest("handler", () => expect(handler(7)).toBe("user7"));\n',
    },
    check: both(
      succeeds("! grep -rq getUser src && grep -q 'export function fetchUser' src/users.ts"),
      succeeds("bun test"),
    ),
    reference: { command: "sed -i.bak 's/getUser/fetchUser/g' src/*.ts && rm src/*.bak" },
  },
  {
    name: "answer",
    skill: "answer a question from the code",
    prompt: "What port does the server listen on when PORT is not set? Answer with just the number.",
    files: {
      "src/config.ts": "const BASE = 8000;\nexport const OFFSET = 123;\nexport const DEFAULT_PORT = BASE + OFFSET;\n",
      "src/server.ts":
        'import { DEFAULT_PORT } from "./config.ts";\n\nBun.serve({ port: Number(process.env.PORT ?? DEFAULT_PORT), fetch: () => new Response("ok") });\n',
    },
    check: answers(/\b8123\b/),
    reference: { answer: "8123" },
  },
  {
    name: "search-log",
    skill: "find one line in a large file without reading it all",
    prompt: "logs/app.log contains exactly one error. Which order id failed? Answer with just the id.",
    files: {
      "logs/app.log": Array.from({ length: 20_000 }, (_, i) =>
        i === 13_377
          ? "2026-01-01T03:42:17Z ERROR payment declined order=ord_7f3a9"
          : `2026-01-01T03:42:17Z INFO request ${i} ok order=ord_${i.toString(16)}`,
      ).join("\n"),
    },
    check: answers(/\bord_7f3a9\b/),
    reference: { answer: "ord_7f3a9" },
  },
  {
    name: "read-only",
    skill: "follow a constraint: inspect without editing",
    prompt: "How many TODO comments are there in src? Do not change any files. Answer with just the number.",
    files: todos,
    check: both(answers(/\b3\b/), ...Object.entries(todos).map(([path, content]) => unchanged(path, content))),
    reference: { answer: "3" },
  },
  {
    name: "feature",
    skill: "add a feature and its tests",
    prompt:
      "Add a peek() method to Stack in src/stack.ts. It returns the top item without removing it, or undefined when the stack is empty. Add tests for it.",
    files: {
      "src/stack.ts":
        "export class Stack<T> {\n  private items: T[] = [];\n  push(item: T) {\n    this.items.push(item);\n  }\n  pop(): T | undefined {\n    return this.items.pop();\n  }\n}\n",
    },
    check: both(
      succeeds(
        `bun -e 'import { Stack } from "./src/stack.ts"; const s = new Stack(); if (s.peek() !== undefined) process.exit(1); s.push(1); s.push(2); if (s.peek() !== 2 || s.pop() !== 2 || s.peek() !== 1) process.exit(1)'`,
      ),
      succeeds("grep -rlq peek --include='*.test.ts' . && bun test"),
    ),
    reference: {
      command: `cat > src/stack.ts <<'EOF'
export class Stack<T> {
  private items: T[] = [];
  push(item: T) {
    this.items.push(item);
  }
  peek(): T | undefined {
    return this.items.at(-1);
  }
  pop(): T | undefined {
    return this.items.pop();
  }
}
EOF
cat > stack.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { Stack } from "./src/stack.ts";
test("peek", () => {
  const s = new Stack<number>();
  expect(s.peek()).toBeUndefined();
  s.push(1);
  expect(s.peek()).toBe(1);
});
EOF`,
    },
  },
  {
    name: "config",
    skill: "edit structured config",
    prompt: 'Add a "format" script to package.json that runs "prettier --write .". Keep everything else as it is.',
    files: {
      "package.json": JSON.stringify(
        { name: "app", version: "1.0.0", scripts: { test: "bun test" }, dependencies: { zod: "^4.0.0" } },
        null,
        2,
      ),
    },
    check: succeeds(
      `bun -e 'const p = await Bun.file("package.json").json(); process.exit(p.scripts?.format === "prettier --write ." && p.scripts.test === "bun test" && p.dependencies?.zod === "^4.0.0" && p.name === "app" ? 0 : 1)'`,
    ),
    reference: {
      command: `bun -e 'const p = await Bun.file("package.json").json(); p.scripts.format = "prettier --write ."; await Bun.write("package.json", JSON.stringify(p, null, 2))'`,
    },
  },
];
