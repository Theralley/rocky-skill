#!/usr/bin/env node
// Tests for repo-local config resolution in getDefaultMode().
// Covers the resolution-order contract:
//   env ROCKY_DEFAULT_MODE → repo-local (.rocky/config.json or .rocky.json,
//   walking up to filesystem root) → user config → 'rocky'.
// Legacy level names (lite/full/ultra/wenyan*) in any source resolve to the
// skill they became.
//
// Run: node tests/test_repo_local_config.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// Isolate from the host's real user config: point XDG_CONFIG_HOME at a tmp dir
// before requiring the module so getConfigPath() never reads the developer's
// own ~/.config/rocky/config.json.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-userhome-'));
process.env.XDG_CONFIG_HOME = tmpHome;
delete process.env.ROCKY_DEFAULT_MODE;

const { getDefaultMode, findRepoConfigPath } = require('../src/hooks/rocky-config');

let passed = 0;
let failed = 0;

function test(name, fn) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-repocfg-'));
  const origCwd = process.cwd();
  const origEnv = process.env.ROCKY_DEFAULT_MODE;
  try {
    fn(tmpBase);
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  } finally {
    process.chdir(origCwd);
    if (origEnv === undefined) delete process.env.ROCKY_DEFAULT_MODE;
    else process.env.ROCKY_DEFAULT_MODE = origEnv;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

console.log('repo-local config resolution tests\n');

test('returns "rocky" when no env, no repo config, no user config', (tmp) => {
  process.chdir(tmp);
  assert.strictEqual(getDefaultMode(), 'rocky');
});

test('reads .rocky/config.json in cwd', (tmp) => {
  fs.mkdirSync(path.join(tmp, '.rocky'));
  fs.writeFileSync(path.join(tmp, '.rocky', 'config.json'),
    JSON.stringify({ defaultMode: 'lite' }));
  process.chdir(tmp);
  assert.strictEqual(getDefaultMode(), 'rocky');
});

test('reads .rocky.json in cwd', (tmp) => {
  fs.writeFileSync(path.join(tmp, '.rocky.json'),
    JSON.stringify({ defaultMode: 'ultra' }));
  process.chdir(tmp);
  assert.strictEqual(getDefaultMode(), 'ultrarocky');
});

test('.rocky/config.json wins over .rocky.json at same level', (tmp) => {
  fs.mkdirSync(path.join(tmp, '.rocky'));
  fs.writeFileSync(path.join(tmp, '.rocky', 'config.json'),
    JSON.stringify({ defaultMode: 'lite' }));
  fs.writeFileSync(path.join(tmp, '.rocky.json'),
    JSON.stringify({ defaultMode: 'ultra' }));
  process.chdir(tmp);
  assert.strictEqual(getDefaultMode(), 'rocky');
});

test('walks up from nested cwd to find repo config', (tmp) => {
  fs.mkdirSync(path.join(tmp, '.rocky'));
  fs.writeFileSync(path.join(tmp, '.rocky', 'config.json'),
    JSON.stringify({ defaultMode: 'wenyan-lite' }));
  const nested = path.join(tmp, 'a', 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });
  process.chdir(nested);
  assert.strictEqual(getDefaultMode(), 'megarocky');
});

test('env var beats repo-local config', (tmp) => {
  fs.mkdirSync(path.join(tmp, '.rocky'));
  fs.writeFileSync(path.join(tmp, '.rocky', 'config.json'),
    JSON.stringify({ defaultMode: 'lite' }));
  process.chdir(tmp);
  process.env.ROCKY_DEFAULT_MODE = 'ultra';
  assert.strictEqual(getDefaultMode(), 'ultrarocky');
});

test('repo-local config beats user config', (tmp) => {
  // user config at XDG_CONFIG_HOME points to 'commit'
  fs.mkdirSync(path.join(tmpHome, 'rocky'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, 'rocky', 'config.json'),
    JSON.stringify({ defaultMode: 'commit' }));
  // repo-local points to 'lite'
  fs.mkdirSync(path.join(tmp, '.rocky'));
  fs.writeFileSync(path.join(tmp, '.rocky', 'config.json'),
    JSON.stringify({ defaultMode: 'lite' }));
  process.chdir(tmp);
  try {
    assert.strictEqual(getDefaultMode(), 'rocky');
  } finally {
    fs.rmSync(path.join(tmpHome, 'rocky'), { recursive: true, force: true });
  }
});

test('falls through to user config when repo config absent', (tmp) => {
  fs.mkdirSync(path.join(tmpHome, 'rocky'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, 'rocky', 'config.json'),
    JSON.stringify({ defaultMode: 'review' }));
  process.chdir(tmp);
  try {
    assert.strictEqual(getDefaultMode(), 'review');
  } finally {
    fs.rmSync(path.join(tmpHome, 'rocky'), { recursive: true, force: true });
  }
});

test('invalid mode in repo config falls through to default', (tmp) => {
  fs.writeFileSync(path.join(tmp, '.rocky.json'),
    JSON.stringify({ defaultMode: 'definitely-not-a-mode' }));
  process.chdir(tmp);
  assert.strictEqual(getDefaultMode(), 'rocky');
});

test('malformed JSON in repo config falls through to default', (tmp) => {
  fs.mkdirSync(path.join(tmp, '.rocky'));
  fs.writeFileSync(path.join(tmp, '.rocky', 'config.json'), '{ not json');
  process.chdir(tmp);
  assert.strictEqual(getDefaultMode(), 'rocky');
});

test('refuses symlinked .rocky.json (symmetric with readFlag policy)', (tmp) => {
  const real = path.join(tmp, 'real-config.json');
  fs.writeFileSync(real, JSON.stringify({ defaultMode: 'ultra' }));
  try {
    fs.symlinkSync(real, path.join(tmp, '.rocky.json'));
  } catch (e) {
    // Skip on platforms without symlink perms
    console.log('    (skipped: symlink not permitted)');
    return;
  }
  process.chdir(tmp);
  assert.strictEqual(getDefaultMode(), 'rocky');
});

test('findRepoConfigPath returns null outside any repo', (tmp) => {
  process.chdir(tmp);
  assert.strictEqual(findRepoConfigPath(tmp), null);
});

// ── #634: optional startDir param (backward compatible) ────────────────────

test('getDefaultMode(startDir) resolves repo config for a directory other than process.cwd()', (tmp) => {
  fs.writeFileSync(path.join(tmp, '.rocky.json'), JSON.stringify({ defaultMode: 'off' }));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-elsewhere-'));
  try {
    process.chdir(elsewhere); // process cwd has no repo config
    assert.strictEqual(getDefaultMode(), 'rocky', 'process cwd alone should not see the other dir\'s config');
    assert.strictEqual(getDefaultMode(tmp), 'off', 'startDir should resolve that directory\'s repo config');
  } finally {
    // Leave the directory before removing it — Windows EBUSYs on rmdir of cwd.
    process.chdir(tmp);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('getDefaultMode() with no args is unchanged (defaults to process.cwd())', (tmp) => {
  fs.writeFileSync(path.join(tmp, '.rocky.json'), JSON.stringify({ defaultMode: 'lite' }));
  process.chdir(tmp);
  assert.strictEqual(getDefaultMode(), 'rocky');
  assert.strictEqual(getDefaultMode(undefined), 'rocky');
});

test('new mode ids are accepted from every source', (tmp) => {
  fs.writeFileSync(path.join(tmp, '.rocky.json'), JSON.stringify({ defaultMode: 'megarocky' }));
  process.chdir(tmp);
  assert.strictEqual(getDefaultMode(), 'megarocky');
  process.env.ROCKY_DEFAULT_MODE = 'ultrarocky';
  assert.strictEqual(getDefaultMode(), 'ultrarocky');
  process.env.ROCKY_DEFAULT_MODE = 'manual';
  assert.strictEqual(getDefaultMode(), 'manual', 'manual stays a default-policy value');
});

// C37: hand-edited config files. PowerShell 5.1's `>` writes UTF-16LE with a
// BOM, `Set-Content -Encoding UTF8` a UTF-8 BOM; comments and trailing commas
// are what installer/lib/settings.js already tolerates in settings.json.
test('a BOM, UTF-16LE, a comment or a trailing comma does not drop defaultMode', (tmp) => {
  const json = '{"defaultMode":"off"}';
  const variants = {
    'UTF-8 BOM': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]),
    'UTF-16LE BOM': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]),
    'line comment': '// mine\n{"defaultMode":"off"} // trailing',
    'block comment': '/* mine */ {"defaultMode": /* why */ "off"}',
    'trailing comma': '{\n  "defaultMode": "off",\n}',
    'comment-like string': '{"note": "http://x // y,}", "defaultMode": "off",}',
  };
  fs.mkdirSync(path.join(tmpHome, 'rocky'), { recursive: true });
  process.chdir(tmp);
  try {
    for (const [name, content] of Object.entries(variants)) {
      fs.writeFileSync(path.join(tmpHome, 'rocky', 'config.json'), content);
      assert.strictEqual(getDefaultMode(), 'off', `user config with ${name}`);
      fs.writeFileSync(path.join(tmp, '.rocky.json'), content);
      assert.strictEqual(getDefaultMode(), 'off', `.rocky.json with ${name}`);
      fs.rmSync(path.join(tmp, '.rocky.json'));
    }
  } finally {
    fs.rmSync(path.join(tmpHome, 'rocky'), { recursive: true, force: true });
  }
});

// C38: the docs give ~/.config/rocky/config.json for every platform. Windows
// reads %APPDATA%\rocky\config.json first, then that path.
test('Windows reads %APPDATA% then ~/.config for the user config', (tmp) => {
  const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, APPDATA: process.env.APPDATA,
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  delete process.env.XDG_CONFIG_HOME;
  process.env.APPDATA = path.join(tmp, 'appdata');
  process.env.HOME = process.env.USERPROFILE = path.join(tmp, 'home');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    process.chdir(tmp);
    fs.mkdirSync(path.join(tmp, 'home', '.config', 'rocky'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'home', '.config', 'rocky', 'config.json'), '{"defaultMode":"off"}');
    assert.strictEqual(getDefaultMode(), 'off', '~/.config is read when %APPDATA% has none');
    fs.mkdirSync(path.join(tmp, 'appdata', 'rocky'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'appdata', 'rocky', 'config.json'), '{"defaultMode":"ultra"}');
    assert.strictEqual(getDefaultMode(), 'ultrarocky', '%APPDATA% wins when both name a mode');
  } finally {
    Object.defineProperty(process, 'platform', platform);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// C39: .rocky/config.json is also the CLI's project overlay, so it often
// holds no defaultMode. It must not hide a sibling .rocky.json or a parent's.
test('a .rocky/config.json without defaultMode does not hide .rocky.json', (tmp) => {
  fs.mkdirSync(path.join(tmp, '.rocky'));
  fs.writeFileSync(path.join(tmp, '.rocky', 'config.json'), JSON.stringify({ execute: { mcp: false } }));
  fs.writeFileSync(path.join(tmp, '.rocky.json'), JSON.stringify({ defaultMode: 'off' }));
  const nested = path.join(tmp, 'sub');
  fs.mkdirSync(path.join(nested, '.rocky'), { recursive: true });
  fs.writeFileSync(path.join(nested, '.rocky', 'config.json'), '{}');
  process.chdir(tmp);
  assert.strictEqual(getDefaultMode(), 'off', 'sibling .rocky.json');
  assert.strictEqual(getDefaultMode(nested), 'off', 'parent directory');
});

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(tmpHome, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
