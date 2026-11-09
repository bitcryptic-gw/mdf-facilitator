/**
 * template.test.ts — the Unraid template guard.
 *
 * Four separate outages came from elements dockerMan does not act on:
 * <Environment> (never reached the container), a missing state-dir element,
 * <Networking>, and <Data> (mounts silently dropped). This test parses the
 * templates and fails on any of them, and on anything else the run path needs.
 *
 * The rules are checked against a tiny reimplementation of the relevant parts
 * of Unraid's xmlToCommand() (dynamix.docker.manager/include/Helpers.php:389):
 *   - `-v` comes only from <Config> entries with Type Path (:514-517)
 *   - `-e` comes from <Config> entries with Type Variable (:504-513)
 *   - <Config> Type Port would become `-p`
 * Everything else (<Data>, <Networking>, <Environment>) is inert on the run
 * path, which is exactly the bug class this guards.
 *
 * TEMPLATE_DIR overrides the directory, so the same test can be run against a
 * previous revision to prove it would have caught the bug.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Node {
  name: string;
  text: string;
  children: Node[];
}

const TEMPLATE_DIR = process.env.TEMPLATE_DIR ?? join(process.cwd(), "deploy");

/** Parse the direct children of <Container>. Enough XML for a template. */
export function parseTopLevel(xml: string): Node[] {
  const withoutComments = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    // Drop the outer <Container> wrapper: its children are what we check.
    .replace(/<Container\b[^>]*>/, "")
    .replace(/<\/Container>\s*$/, "");
  const top: Node[] = [];
  const stack: Node[] = [];
  const tag = /<(\/?)([A-Za-z][\w.-]*)([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  let textStart = 0;

  while ((match = tag.exec(withoutComments)) !== null) {
    const whole = match[0];
    const closing = match[1] === "/";
    const name = match[2] ?? "";
    const selfClosing = match[4] === "/";
    const text = withoutComments.slice(textStart, match.index).trim();
    const current = stack[stack.length - 1];
    if (text && current) current.text += text;
    textStart = match.index + whole.length;

    if (closing) {
      const node = stack.pop();
      if (!node) continue;
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else top.push(node);
      continue;
    }
    const node: Node = { name, text: "", children: [] };
    if (selfClosing) {
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else top.push(node);
    } else {
      stack.push(node);
    }
  }
  return top;
}

function templates(): Array<{ file: string; nodes: Node[] }> {
  return readdirSync(TEMPLATE_DIR)
    .filter((f) => f.startsWith("my-mdf-facilitator-") && f.endsWith(".xml"))
    .sort()
    .map((file) => ({ file, nodes: parseTopLevel(readFileSync(join(TEMPLATE_DIR, file), "utf8")) }));
}

function find(nodes: Node[], name: string): Node | undefined {
  return nodes.find((n) => n.name === name);
}

function text(nodes: Node[], name: string): string | null {
  const node = find(nodes, name);
  return node ? node.text : null;
}

interface ConfigEntry {
  target: string;
  value: string;
  mode: string;
  type: string;
}

function configEntries(nodes: Node[]): ConfigEntry[] {
  return nodes
    .filter((n) => n.name === "Config")
    .map((n) => ({
      target: n.children.find((c) => c.name === "Target")?.text ?? "",
      value:
        n.children.find((c) => c.name === "Value")?.text ||
        n.children.find((c) => c.name === "Default")?.text ||
        "",
      mode: n.children.find((c) => c.name === "Mode")?.text ?? "",
      type: (n.children.find((c) => c.name === "Type")?.text ?? "").toLowerCase(),
    }));
}

/**
 * The `docker run` arguments xmlToCommand() would build, limited to the parts a
 * template controls: volume and variable Config entries, and ExtraParams.
 */
export function renderRunArgs(nodes: Node[]): string {
  const parts: string[] = [];
  for (const entry of configEntries(nodes)) {
    if (!entry.target) continue;
    if (entry.type === "path") parts.push(`-v ${entry.value}:${entry.target}:${entry.mode || "rw"}`);
    else if (entry.type === "variable") parts.push(`-e ${entry.target}=${entry.value}`);
    else if (entry.type === "port") parts.push(`-p ${entry.value}:${entry.target}`);
  }
  const extra = text(nodes, "ExtraParams");
  if (extra) parts.push(extra);
  return parts.join(" ");
}

const LEGACY_ELEMENTS = ["Data", "Networking", "Environment"];
const V1_TAILSCALE: Record<string, string> = {
  TailscaleIsExitNode: "false",
  TailscaleExitNodeIP: "",
  TailscaleServe: "no",
  TailscaleDParams: "",
  TailscaleRoutes: "",
  TailscaleAcceptRoutes: "false",
  TailscaleWebUI: "http://[noserve]/health",
};

test("there is exactly one template per leg", () => {
  const found = templates().map((t) => t.file);
  assert.deepEqual(found, ["my-mdf-facilitator-public.xml", "my-mdf-facilitator-syd.xml"]);
});

for (const { file, nodes } of templates()) {
  test(`${file}: no legacy elements dockerMan ignores`, () => {
    for (const legacy of LEGACY_ELEMENTS) {
      assert.equal(
        find(nodes, legacy),
        undefined,
        `<${legacy}> is ignored by xmlToCommand() on the run path — express it as <Config> entries instead`
      );
    }
  });

  test(`${file}: both mounts are <Config Type="Path">`, () => {
    const entries = configEntries(nodes);
    const secrets = entries.find((e) => e.target === "/run/secrets");
    const data = entries.find((e) => e.target === "/app/data");
    assert.ok(secrets, "missing <Config> for /run/secrets (the signer key would not be mounted)");
    assert.equal(secrets?.type, "path");
    assert.equal(secrets?.mode, "ro");
    assert.match(secrets?.value ?? "", /^\/mnt\/cache\/appdata\/mdf-facilitator-(syd|public)\/secrets$/);
    assert.ok(data, "missing <Config> for /app/data (Tailscale state would live in the container layer)");
    assert.equal(data?.type, "path");
    assert.equal(data?.mode, "rw");
    assert.match(data?.value ?? "", /^\/mnt\/cache\/appdata\/mdf-facilitator-(syd|public)\/data$/);
  });

  test(`${file}: Tailscale elements match the v1 pattern`, () => {
    for (const [name, expected] of Object.entries(V1_TAILSCALE)) {
      const actual = text(nodes, name);
      assert.notEqual(actual, null, `missing <${name}> (v1 carries it)`);
      assert.equal(actual, expected, `<${name}> is "${actual}", expected "${expected}"`);
    }
    assert.equal(text(nodes, "TailscaleEnabled"), "true");
    assert.equal(text(nodes, "TailscaleStateDir"), "/app/data/.tailscale_state");
    assert.equal(text(nodes, "TailscaleUserspaceNetworking"), "false");
    assert.equal(text(nodes, "TailscaleLANAccess"), "false");
    assert.equal(text(nodes, "TailscaleSSH"), "false");
    assert.equal(text(nodes, "TailscaleHostname"), file.replace(/^my-/, "").replace(/\.xml$/, ""));
  });

  test(`${file}: TailscaleParams is empty`, () => {
    assert.equal(text(nodes, "TailscaleParams"), "", "the auth key must be cleared after the first join");
  });

  test(`${file}: no published port`, () => {
    assert.equal(
      configEntries(nodes).some((e) => e.type === "port"),
      false,
      "a published port would expose the unauthenticated /settle to the LAN"
    );
    assert.equal(text(nodes, "Network"), "bridge");
  });

  test(`${file}: the rendered run arguments carry both mounts, --user and no -p`, () => {
    const args = renderRunArgs(nodes);
    assert.match(args, /-v \/mnt\/cache\/appdata\/mdf-facilitator-(syd|public)\/secrets:\/run\/secrets:ro/);
    assert.match(args, /-v \/mnt\/cache\/appdata\/mdf-facilitator-(syd|public)\/data:\/app\/data:rw/);
    assert.match(args, /--user 0:0/);
    assert.doesNotMatch(args, /(^| )-p /);
  });
}
