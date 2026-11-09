<?php
/**
 * xmlconfig.php — Unraid's own template parsing, in PHP, for the template guard.
 *
 * This is a faithful copy of the two places in Unraid's webgui that decide what a
 * template actually becomes at run time. It exists so the repository can be
 * checked against the real parser instead of a reimplementation of it: a
 * hand-written parser in tests/template.test.ts once read child elements
 * (<Config><Target>…</Target></Config>) that dockerMan never reads, and every
 * <Config> entry was silently skipped — no mounts, no variables (MDF #63).
 *
 * Source:    unraid/webgui
 *            emhttp/plugins/dynamix.docker.manager/include/Helpers.php
 * Commit:    ebd05afeb31878dca76d22c198b236d27cfec163
 *            (master HEAD for that path when this file was written, 2026-11-10;
 *            the file's last change upstream is the same commit, 2026-09-10)
 *
 * Copied from:
 *   - xmlToVar()'s <Config> loop, lines 263–284: value = element text, falling
 *     back to the Default attribute; every field read from $config->attributes()
 *     only; Mode normalised per Type (Path → rw/ro variants else rw, Port →
 *     tcp/udp else tcp).
 *   - xmlToCommand()'s <Config> selection, lines 503–530: an entry with no Target
 *     is skipped unless its Type is "device"; Type Path → -v host:target:mode,
 *     Type Variable → -e target=value, Type Port → -p.
 *
 * Usage: php tests/unraid/xmlconfig.php <template.xml>
 * Exit:  0 always; the printed lines are the assertion surface. "SKIPPED" means
 *        Unraid would drop that entry at run time.
 */

// Helpers.php:31-33
function xml_decode($string) {
  return strval(html_entity_decode($string, ENT_XML1, 'UTF-8'));
}

libxml_use_internal_errors(true);
$xml = simplexml_load_file($argv[1]);
if ($xml === false) {
  foreach (libxml_get_errors() as $error) {
    fwrite(STDERR, trim($error->message) . "\n");
  }
  fwrite(STDERR, "not well-formed XML: $argv[1]\n");
  exit(2);
}

// xmlToVar():263-284
$out = [];
foreach ($xml->Config as $config) {
  $c = [];
  $c['Value'] = strlen(xml_decode($config)) ? xml_decode($config) : xml_decode($config['Default']);
  foreach ($config->attributes() as $key => $value) {
    $value = xml_decode($value);
    if ($key == 'Mode') {
      switch (xml_decode($config['Type'])) {
      case 'Path':
        $value = in_array(strtolower($value), ['rw', 'rw,slave', 'rw,shared', 'ro', 'ro,slave', 'ro,shared']) ? $value : "rw";
        break;
      case 'Port':
        $value = in_array(strtolower($value), ['tcp', 'udp']) ? $value : "tcp";
        break;
      }
    }
    $c[$key] = strip_tags(html_entity_decode($value));
  }
  $out[] = $c;
}

// xmlToCommand():503-530
foreach ($out as $config) {
  $confType        = strtolower(strval($config['Type'] ?? ''));
  $hostConfig      = strlen($config['Value']) ? $config['Value'] : ($config['Default'] ?? '');
  $containerConfig = strval($config['Target'] ?? '');
  $Mode            = strval($config['Mode'] ?? '');
  if ($confType != "device" && !strlen($containerConfig)) {
    echo "  SKIPPED (no Target attribute)\n";
    continue;
  }
  if ($confType == "path") {
    if (!trim($hostConfig) || !trim($containerConfig)) {
      echo "  SKIPPED (empty host or container path)\n";
      continue;
    }
    echo "  -v $hostConfig:$containerConfig:$Mode\n";
  } elseif ($confType == "variable") {
    echo "  -e $containerConfig=$hostConfig\n";
  } elseif ($confType == "port") {
    echo "  -p $hostConfig:$containerConfig/$Mode\n";
  } elseif ($confType == "device") {
    echo "  --device $hostConfig\n";
  } else {
    echo "  ($confType) $containerConfig\n";
  }
}
