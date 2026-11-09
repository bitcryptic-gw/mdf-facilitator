/**
 * template.test.ts — the Unraid template guard.
 *
 * Five separate outages came from elements dockerMan does not act on:
 * <Environment> (never reached the container), a missing state-dir element,
 * <Networking>, <Data> (mounts silently dropped), and — MDF #63, 2026-11-10 —
 * <Config> entries written as child elements instead of attributes, which made
 * every mount and every variable silently disappear.
 *
 * The rules are checked against Unraid's real parsing, not a reimplementation of
 * it, because the reimplementation is what shared the author's misunderstanding:
 *
 *  - `xmlToVar()` (emhttp/plugins/dynamix.docker.manager/include/Helpers.php:263-284)
 *    reads **only attributes** from a <Config> (`$config->attributes()`), and the
 *    value is the element's text, falling back to the `Default` attribute.
 *    Child elements named <Target>, <Type>, <Default> … are invisible to it.
 *  - `xmlToCommand()` (:503-530) then skips any entry without a `Target`
 *    unless its Type is "device", builds `-v` from Type Path, `-e` from Type
 *    Variable and `-p` from Type Port.
 *
 * Three independent layers, so no single mistake can pass again:
 *  1. every template is parsed by PHP's simplexml/libxml — the parser Unraid
 *     itself uses — and any error fails. A `--` inside a comment is illegal XML,
 *     makes simplexml return false, and leaves the Unraid UI showing a blank
 *     template with no error at all.
 *  2. tests/unraid/xmlconfig.php, a faithful copy of the two code paths above,
 *     is run on each template and its output asserted.
 *  3. the structure is compared against deploy/v1-x402-facilitator-*.xml, the
 *     templates of the containers that are running today.
 *
 * TEMPLATE_DIR overrides the directory, so the same test can be run against a
 * previous revision to prove it catches the bug.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Node {
  name: string;
  text: string;
  attrs: Record<string, string>;
  children: Node[];
}

const TEMPLATE_DIR = process.env.TEMPLATE_DIR ?? join(process.cwd(), "deploy");
const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "unraid", "xmlconfig.php");

/**
 * Parse the direct children of <Container>. Enough XML for a template, and it
 * keeps attributes — the part that matters here. Attribute values may contain
 * `>`, so quoted runs are matched as opaque.
 */
export function parseTopLevel(xml: string): Node[] {
  const withoutComments = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    // Drop the outer <Container> wrapper: its children are what we check.
    .replace(/<Container\b[^>]*>/, "")
    .replace(/<\/Container>\s*$/, "");
  const top: Node[] = [];
  const stack: Node[] = [];
  const tag = /<(\/?)([A-Za-z][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
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
    const node: Node = { name, text: "", attrs: parseAttributes(match[3] ?? ""), children: [] };
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

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attr = /([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attr.exec(source)) !== null) {
    const name = match[1] ?? "";
    if (name) attrs[name] = match[2] ?? match[3] ?? "";
  }
  return attrs;
}

function templates(): Array<{ file: string; xml: string; nodes: Node[] }> {
  return readdirSync(TEMPLATE_DIR)
    .filter((f) => f.startsWith("my-mdf-facilitator-") && f.endsWith(".xml"))
    .sort()
    .map((file) => {
      const xml = readFileSync(join(TEMPLATE_DIR, file), "utf8");
      return { file, xml, nodes: parseTopLevel(xml) };
    });
}

function find(nodes: Node[], name: string): Node | undefined {
  return nodes.find((n) => n.name === name);
}

function text(nodes: Node[], name: string): string | null {
  const node = find(nodes, name);
  return node ? node.text : null;
}

/** The v1 reference templates: the containers that are running in production. */
function referenceTemplates(): Array<{ file: string; nodes: Node[] }> {
  return readdirSync(TEMPLATE_DIR)
    .filter((f) => f.startsWith("v1-x402-facilitator-") && f.endsWith(".xml"))
    .sort()
    .map((file) => ({ file, nodes: parseTopLevel(readFileSync(join(TEMPLATE_DIR, file), "utf8")) }));
}

interface ConfigEntry {
  name: string;
  target: string;
  value: string;
  mode: string;
  type: string;
  attrs: Record<string, string>;
  children: Node[];
}

/**
 * What xmlToVar() builds from a <Config>: attributes only, plus the element text
 * (falling back to `Default`) as the value. Deliberately no child-element reads.
 */
function configEntries(nodes: Node[]): ConfigEntry[] {
  return nodes
    .filter((n) => n.name === "Config")
    .map((n) => ({
      name: n.attrs.Name ?? "",
      target: n.attrs.Target ?? "",
      value: n.text || (n.attrs.Default ?? ""),
      mode: n.attrs.Mode ?? "",
      type: (n.attrs.Type ?? "").toLowerCase(),
      attrs: n.attrs,
      children: n.children,
    }));
}

/**
 * The `docker run` arguments xmlToCommand() would build, limited to the parts a
 * template controls: volume, variable, port and device Config entries, then
 * ExtraParams. An entry with no Target is dropped exactly as dockerMan drops it.
 */
export function renderRunArgs(nodes: Node[]): string {
  const parts: string[] = [];
  for (const entry of configEntries(nodes)) {
    if (entry.type !== "device" && !entry.target) continue;
    if (entry.type === "path") parts.push(`-v ${entry.value}:${entry.target}:${entry.mode || "rw"}`);
    else if (entry.type === "variable") parts.push(`-e ${entry.target}=${entry.value}`);
    else if (entry.type === "port") parts.push(`-p ${entry.value}:${entry.target}`);
    else if (entry.type === "device") parts.push(`--device ${entry.value}`);
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

/**
 * Top-level elements the v1 reference carries that ours deliberately does not.
 * Anything not listed here and missing from our templates fails the test.
 */
const V1_ELEMENT_ALLOWLIST: Record<string, string> = {
  MyMAC: "empty in v1; xmlToVar() falls back to '' / ExtraParams, so absent == empty",
  ReadMe: "UI-only readme pane; empty in v1 and unused by xmlToCommand()",
  Requires: "UI dependency hint; never read on the run path",
};

/** Run one template through PHP's simplexml — the parser Unraid uses. */
function phpStrictParse(file: string): void {
  const script = [
    "libxml_use_internal_errors(true);",
    "$x = simplexml_load_file($argv[1]);",
    "if ($x === false) {",
    "  foreach (libxml_get_errors() as $e) fwrite(STDERR, trim($e->message) . PHP_EOL);",
    "  exit(1);",
    "}",
  ].join("\n");
  try {
    execFileSync("php", ["-r", script, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") {
      assert.fail("php is required for the template guard (Unraid parses templates with simplexml); install php to run npm test");
    }
    assert.fail(`${file} is not well-formed XML: ${(err.stderr ?? err.message).trim()}`);
  }
}

/** Run the faithful copy of Unraid's parser. */
function runUnraidParser(file: string): string[] {
  const out = execFileSync("php", [HARNESS, join(TEMPLATE_DIR, file)], { encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("there is exactly one template per leg", () => {
  const found = templates().map((t) => t.file);
  assert.deepEqual(found, ["my-mdf-facilitator-public.xml", "my-mdf-facilitator-syd.xml"]);
});

test("the v1 reference templates are present to compare against", () => {
  assert.deepEqual(
    referenceTemplates().map((t) => t.file),
    ["v1-x402-facilitator-public.xml", "v1-x402-facilitator-syd.xml"]
  );
});

for (const { file, nodes } of templates()) {
  test(`${file}: parses with simplexml, the parser Unraid uses`, () => {
    phpStrictParse(join(TEMPLATE_DIR, file));
  });

  test(`${file}: no legacy elements dockerMan ignores`, () => {
    for (const legacy of LEGACY_ELEMENTS) {
      assert.equal(
        find(nodes, legacy),
        undefined,
        `<${legacy}> is ignored by xmlToCommand() on the run path — express it as <Config> entries instead`
      );
    }
  });

  test(`${file}: every <Config> uses the attribute form and has a Target`, () => {
    const entries = configEntries(nodes);
    assert.ok(entries.length > 0, "no <Config> entries at all");
    for (const entry of entries) {
      assert.equal(
        entry.children.length,
        0,
        `<Config Name="${entry.name}"> has child elements; xmlToVar() reads attributes only, so this entry would be skipped`
      );
      assert.notEqual(
        entry.target,
        "",
        `<Config Name="${entry.name}"> has no Target attribute — xmlToCommand() drops it, so its mount or variable never reaches the container`
      );
      assert.notEqual(entry.name, "", `<Config Target="${entry.target}"> has no Name attribute`);
      assert.notEqual(entry.type, "", `<Config Target="${entry.target}"> has no Type attribute`);
    }
  });

  test(`${file}: <Config> attribute set matches the v1 reference`, () => {
    const reference = referenceTemplates()[0];
    assert.ok(reference, "v1 reference template missing");
    const expected = new Set<string>();
    for (const entry of configEntries(reference.nodes)) for (const key of Object.keys(entry.attrs)) expected.add(key);
    assert.ok(expected.size > 0, "the v1 reference has no <Config> attributes");
    for (const entry of configEntries(nodes)) {
      assert.deepEqual(
        Object.keys(entry.attrs).sort(),
        [...expected].sort(),
        `<Config Name="${entry.name}"> attributes differ from the v1 reference`
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

  test(`${file}: carries every top-level element the v1 reference carries`, () => {
    const ours = new Set(nodes.map((n) => n.name));
    const missing = new Set<string>();
    for (const reference of referenceTemplates()) {
      for (const node of reference.nodes) {
        if (ours.has(node.name)) continue;
        if (node.name in V1_ELEMENT_ALLOWLIST) continue;
        missing.add(node.name);
      }
    }
    assert.deepEqual(
      [...missing].sort(),
      [],
      `v1 carries these top-level elements and we do not: ${[...missing].sort().join(", ")}`
    );
  });

  test(`${file}: the rendered run arguments carry both mounts, --user and no -p`, () => {
    const args = renderRunArgs(nodes);
    assert.match(args, /-v \/mnt\/cache\/appdata\/mdf-facilitator-(syd|public)\/secrets:\/run\/secrets:ro/);
    assert.match(args, /-v \/mnt\/cache\/appdata\/mdf-facilitator-(syd|public)\/data:\/app\/data:rw/);
    assert.match(args, /--user 0:0/);
    assert.doesNotMatch(args, /(^| )-p /);
  });

  test(`${file}: Unraid's own parser builds both mounts and every variable`, () => {
    const lines = runUnraidParser(file);
    assert.deepEqual(lines.filter((l) => l.includes("SKIPPED")), [], "dockerMan would skip config entries");
    const volumes = lines.filter((l) => l.startsWith("-v "));
    const variables = lines.filter((l) => l.startsWith("-e "));
    assert.equal(volumes.length, 2, `expected exactly two mounts, got: ${volumes.join(" | ")}`);
    assert.match(volumes[0] ?? "", /^-v \/mnt\/cache\/appdata\/mdf-facilitator-(syd|public)\/secrets:\/run\/secrets:ro$/);
    assert.match(volumes[1] ?? "", /^-v \/mnt\/cache\/appdata\/mdf-facilitator-(syd|public)\/data:\/app\/data:rw$/);
    const expectedVariables = configEntries(nodes)
      .filter((e) => e.type === "variable")
      .map((e) => e.target)
      .sort();
    assert.ok(expectedVariables.length > 0, "no variable <Config> entries");
    assert.deepEqual(
      variables.map((l) => l.slice(3).split("=")[0]).sort(),
      expectedVariables,
      "the variables dockerMan builds differ from the template's Type=Variable entries"
    );
  });
}

/**
 * The parser direction, pinned. The 83e5331 form — child elements — must produce
 * no mounts and no variables here, because that is what it produced in Unraid.
 */
test("child-element <Config> entries are rejected, attribute-form entries are read", () => {
  const childForm = parseTopLevel(
    `<Container version="2">
      <Config>
        <Name>Signer secrets</Name>
        <Target>/run/secrets</Target>
        <Default>/mnt/cache/appdata/x/secrets</Default>
        <Mode>ro</Mode>
        <Type>Path</Type>
      </Config>
    </Container>`
  );
  assert.equal(configEntries(childForm)[0]?.target, "", "a child-element Target must not be read as a Target");
  assert.doesNotMatch(renderRunArgs(childForm), /-v /);

  const attributeForm = parseTopLevel(
    `<Container version="2">
      <Config Name="Signer secrets" Target="/run/secrets" Default="/mnt/cache/appdata/x/secrets" Mode="ro" Type="Path">/mnt/cache/appdata/x/secrets</Config>
    </Container>`
  );
  assert.equal(configEntries(attributeForm)[0]?.target, "/run/secrets");
  assert.match(renderRunArgs(attributeForm), /-v \/mnt\/cache\/appdata\/x\/secrets:\/run\/secrets:ro/);
});
