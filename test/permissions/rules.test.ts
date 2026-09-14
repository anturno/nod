import { describe, expect, test } from "bun:test";
import {
  canonicalHost,
  describePermissions,
  directoryTreeMatch,
  effectiveRules,
  formatPermissions,
  parseRules,
  permissionName,
  type Rule,
  ruleDecision,
  rulesDenyAllTargets,
  staticCommandWildcardMatch,
  wildcardMatch,
} from "../../src/core/permissions/index.ts";

const rule = (permission: string, pattern: string, action: Rule["action"]): Rule => ({ permission, pattern, action });

describe("parseRules", () => {
  test("bare action, action per permission, and pattern maps keep declaration order", () => {
    expect(parseRules("ask").rules).toEqual([rule("*", "*", "ask")]);
    const parsed = parseRules(
      { "*": "ask", bash: { "git *": "allow", "git push *": "deny" }, edit: { "*": "deny", "docs/*": "ALLOW" } },
      "workspace",
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.rules.map((r) => `${r.action} ${r.permission} ${r.pattern} ${r.source}`)).toEqual([
      "ask * * workspace",
      "allow bash git * workspace",
      "deny bash git push * workspace",
      "deny edit * workspace",
      "allow edit docs/* workspace",
    ]);
  });

  test("invalid entries are skipped with diagnostics", () => {
    const parsed = parseRules({ bash: "maybe", edit: { "src/*": 3 }, read: ["allow"], " ": "allow", glob: "deny" });
    expect(parsed.rules).toEqual([rule("glob", "*", "deny")]);
    expect(parsed.diagnostics).toHaveLength(4);
    expect(parseRules(42).rules).toEqual([]);
    expect(parseRules(undefined)).toEqual({ rules: [], diagnostics: [] });
  });
});

describe("matching", () => {
  test("wildcardMatch backtracks on * and ?", () => {
    expect(wildcardMatch("*", "anything")).toBe(true);
    expect(wildcardMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(wildcardMatch("src/*.ts", "src/a.js")).toBe(false);
    expect(wildcardMatch("a*b*c", "axxbyyc")).toBe(true);
    expect(wildcardMatch("a*b*c", "axxbyy")).toBe(false);
    expect(wildcardMatch("file?.txt", "file1.txt")).toBe(true);
    expect(wildcardMatch("file?.txt", "file12.txt")).toBe(false);
    expect(wildcardMatch("", "")).toBe(true);
    expect(wildcardMatch("**", "")).toBe(true);
  });

  test("directoryTreeMatch covers the directory and its descendants only", () => {
    expect(directoryTreeMatch("/ws/**", "/ws")).toBe(true);
    expect(directoryTreeMatch("/ws/**", "/ws/src/a.ts")).toBe(true);
    expect(directoryTreeMatch("/ws/**", "/wsx/a.ts")).toBe(false);
    expect(directoryTreeMatch("/**", "/etc/hosts")).toBe(true);
    expect(directoryTreeMatch("/ws/*", "/ws/a")).toBe(false);
  });

  test("staticCommandWildcardMatch keeps quoted wildcards literal", () => {
    expect(staticCommandWildcardMatch("git *", "git status")).toBe(true);
    expect(staticCommandWildcardMatch("echo '*'", "echo '*'")).toBe(true);
    expect(staticCommandWildcardMatch("echo '*'", "echo 'x'")).toBe(false);
    expect(staticCommandWildcardMatch("bun ?est", "bun test")).toBe(true);
  });

  test("permissionName maps tools to permissions", () => {
    expect(
      ["read_file", "write_file", "edit_file", "glob_files", "grep_files", "shell", "skill", "web_fetch", "vision"].map(
        permissionName,
      ),
    ).toEqual(["read", "edit", "edit", "glob", "grep", "bash", "skill", "web_fetch", "vision"]);
  });
});

describe("ruleDecision", () => {
  test("last match wins and workspace rules follow user rules", () => {
    const user = [rule("edit", "*", "deny")];
    const workspace = [rule("edit", "docs/*", "allow")];
    const rules = effectiveRules(user, workspace);
    expect(ruleDecision(rules, "edit", "edit_file", "docs/readme.md")).toBe("allow");
    expect(ruleDecision(rules, "edit", "edit_file", "src/a.ts")).toBe("deny");
    expect(ruleDecision(rules, "read", "read_file", "src/a.ts")).toBe("none");
    expect(ruleDecision(effectiveRules(workspace, user), "edit", "edit_file", "docs/readme.md")).toBe("deny");
  });

  test("rules match by permission or by tool name, with wildcards", () => {
    expect(ruleDecision([rule("write_file", "*", "ask")], "edit", "write_file", "a.ts")).toBe("ask");
    expect(ruleDecision([rule("write_file", "*", "ask")], "edit", "edit_file", "a.ts")).toBe("none");
    expect(ruleDecision([rule("*", "*", "ask")], "skill", "skill", "x")).toBe("ask");
    expect(ruleDecision([rule("gr*", "*", "allow")], "grep", "grep_files", ".")).toBe("allow");
  });

  test("bash allow rules are strict: exact without wildcard, static commands with", () => {
    const rules = [rule("bash", "git *", "allow")];
    expect(ruleDecision(rules, "bash", "shell", "git status")).toBe("allow");
    expect(ruleDecision(rules, "bash", "shell", "git log --oneline -n 5")).toBe("allow");
    expect(ruleDecision(rules, "bash", "shell", "git status; rm -rf /")).toBe("none");
    expect(ruleDecision(rules, "bash", "shell", "git status && rm -rf /")).toBe("none");
    expect(ruleDecision(rules, "bash", "shell", "git $(cat x)")).toBe("none");
    expect(ruleDecision(rules, "bash", "shell", 'git commit -m "x"')).toBe("none");
    expect(ruleDecision(rules, "bash", "shell", "git commit -m 'x y'")).toBe("allow");
    expect(ruleDecision(rules, "bash", "shell", "FOO=1 git status")).toBe("none");
    expect(ruleDecision([rule("bash", "bun test", "allow")], "bash", "shell", "bun test")).toBe("allow");
    expect(ruleDecision([rule("bash", "bun test", "allow")], "bash", "shell", "bun test x")).toBe("none");
    // deny and ask rules keep ordinary wildcard matching
    expect(ruleDecision([rule("bash", "git push *", "deny")], "bash", "shell", "git push origin; echo hi")).toBe(
      "deny",
    );
    expect(ruleDecision([rule("bash", "*", "ask")], "bash", "shell", "anything | at all")).toBe("ask");
  });

  test("directory tree patterns match path targets", () => {
    const rules = [rule("read", "/etc/**", "allow"), rule("edit", "src/**", "ask")];
    expect(ruleDecision(rules, "read", "read_file", "/etc/hosts")).toBe("allow");
    expect(ruleDecision(rules, "read", "read_file", "/etcetera")).toBe("none");
    expect(ruleDecision(rules, "edit", "edit_file", "src/deep/a.ts")).toBe("ask");
  });

  test("web_fetch rules match canonical hosts exactly", () => {
    const rules = [rule("web_fetch", "domain:example.com", "allow"), rule("web_fetch", "Docs.Example.com", "deny")];
    expect(ruleDecision(rules, "web_fetch", "web_fetch", "domain:example.com")).toBe("allow");
    expect(ruleDecision(rules, "web_fetch", "web_fetch", "domain:docs.example.com")).toBe("deny");
    expect(ruleDecision(rules, "web_fetch", "web_fetch", "domain:other.com")).toBe("none");
    expect(ruleDecision([rule("web_fetch", "*", "deny")], "web_fetch", "web_fetch", "domain:example.com")).toBe("none");
    expect(ruleDecision(rules, "web_fetch", "web_fetch", "example.com")).toBe("none");
  });
});

test("canonicalHost extracts the lowercase host of http(s) URLs", () => {
  expect(canonicalHost("https://Example.COM/path?q=1")).toBe("domain:example.com");
  expect(canonicalHost("http://example.com.:8080/")).toBe("domain:example.com");
  expect(canonicalHost("https://[2001:db8::1]:443/x")).toBe("domain:[2001:db8::1]");
  expect(canonicalHost("https://user@example.com/")).toBeNull();
  expect(canonicalHost("example.com")).toBeNull();
  expect(canonicalHost("https:///path")).toBeNull();
  expect(canonicalHost("https://exa mple.com/")).toBeNull();
});

test("rulesDenyAllTargets detects a final global deny without later exceptions", () => {
  expect(rulesDenyAllTargets([rule("web_search", "*", "deny")], "web_search", "web_search")).toBe(true);
  expect(rulesDenyAllTargets([rule("*", "*", "deny")], "vision", "vision")).toBe(true);
  expect(rulesDenyAllTargets([rule("web_search", "*", "deny"), rule("web_search", "*", "allow")], "web_search")).toBe(
    false,
  );
  expect(rulesDenyAllTargets([rule("edit", "*", "deny"), rule("edit", "docs/*", "allow")], "edit", "edit_file")).toBe(
    false,
  );
  expect(rulesDenyAllTargets([rule("edit", "docs/*", "deny")], "edit", "edit_file")).toBe(false);
  expect(rulesDenyAllTargets([rule("web_fetch", "*", "deny")], "web_fetch", "web_fetch")).toBe(false);
  expect(rulesDenyAllTargets([], "edit")).toBe(false);
});

test("describePermissions and formatPermissions mirror the snapshot", () => {
  const snapshot = {
    mode: "auto" as const,
    workspaceRoot: "/tmp/workspace",
    rules: [rule("edit", "src/*", "allow"), { ...rule("open_url", "*", "ask"), source: "user" as const }],
    grants: [
      { permission: "edit", pattern: "/tmp/workspace/src/app.ts" },
      { permission: "bash", pattern: "npm test" },
    ],
  };
  expect(JSON.stringify(describePermissions(snapshot))).toBe(
    '{"kind":"permissions","mode":"auto","grant_count":2,"grant_scope":"session","runtime_grants_available":true,"rules_scope":"persistent_config","rules":[{"permission":"edit","pattern":"src/*","action":"allow"},{"permission":"open_url","pattern":"*","action":"ask","source":"user"}],"grants":[{"tool_name":"edit","target_path":"/tmp/workspace/src/app.ts","display_target":"src/app.ts"},{"tool_name":"bash","target_path":"npm test","display_target":"npm test"}]}',
  );
  expect(formatPermissions(snapshot, (m) => (m === "yolo" ? "full access" : m))).toBe(
    "[permissions] mode=auto\n[permissions] configured rules:\n - allow edit -> src/*\n - ask open_url -> *\n[permissions] session grants:\n - edit -> src/app.ts\n - bash -> npm test\n",
  );
  expect(formatPermissions({ ...snapshot, rules: [], grants: [] }, (m) => m)).toBe(
    "[permissions] mode=auto\n[permissions] configured rules: (none)\n[permissions] session grants: (none)\n",
  );
});
