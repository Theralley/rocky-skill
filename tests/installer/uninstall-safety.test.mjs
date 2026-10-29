// Uninstall must never leave settings.json pointing at hook scripts it deleted,
// and neither install nor uninstall may touch a hooks/package.json another
// plugin owns.
//
// Both are the same class of bug: installer/install.js treating shared, user-owned
// state in $CLAUDE_CONFIG_DIR/hooks as if rocky owned it outright.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv as isolatedHome } from './_isolated-env.mjs';
import { nodeStub, stubEnv } from '../harness/stub-bin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const INSTALLER = path.join(REPO_ROOT, 'installer', 'install.js');

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-uninstall-safety-'));
}

function fakeClaudeDir(root) {
  const dir = path.join(root, 'fake-bin');
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    // A Node-backed shim: the installer refuses to launch any other .cmd.
    fs.writeFileSync(path.join(dir, 'claude.js'), 'process.exit(0);\n');
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\n"%~dp0\\node.exe" "%~dp0\\claude.js" %*\r\n');
  } else {
    const file = path.join(dir, 'claude');
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

// A throwaway home, and a PATH with only the stubs and system dirs, so the
// installer never reaches the user's real plugin, extension or native-agent
// state.
function isolatedEnv(root, extraBinDirs = []) {
  return isolatedHome(path.join(root, 'home'), [fakeClaudeDir(root), ...extraBinDirs]);
}

// A fake `rocky` CLI that records each invocation (one argument per line,
// invocations separated by a blank line) into `record` and exits 0, the same
// shape `disableNativeAgent`'s real command uses for `rocky disable --all`.
// With `version` it answers `--version` the way the real CLI does; `disable`
// exits `disableExit`.
function fakeRockyDir(root, record, version, disableExit = 0) {
  const reply = version ? JSON.stringify({ version }) : '';
  const dir = path.join(root, 'fake-rocky-bin');
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    // install.js's own portableInvocation() refuses to launch a `.cmd` shim
    // via cmd.exe unless it recognizes it as an npm/pnpm-style Node shim
    // (a line calling node on a sibling .js/.cjs/.mjs file); it launches that
    // script directly with the running node binary instead. Match the same
    // shape the gemini fixture in gemini-install.test.mjs already uses.
    fs.writeFileSync(path.join(dir, 'rocky.js'),
      "const fs = require('node:fs');\n"
      + `fs.appendFileSync(${JSON.stringify(record)}, process.argv.slice(2).join('\\n') + '\\n\\n');\n`
      + `if (process.argv[2] === '--version') console.log(${JSON.stringify(reply)});\n`
      + `if (process.argv[2] === 'disable') process.exit(${disableExit});\n`);
    fs.writeFileSync(path.join(dir, 'rocky.cmd'),
      '@echo off\r\n'
      + '"%~dp0\\node.exe" "%~dp0\\rocky.js" %*\r\n');
  } else {
    const file = path.join(dir, 'rocky');
    fs.writeFileSync(file,
      '#!/bin/sh\n'
      + `{ for a in "$@"; do echo "$a"; done; echo; } >> "${record}"\n`
      + `[ "$1" = --version ] && echo '${reply}'\n`
      + `[ "$1" = disable ] && exit ${disableExit}\n`
      + 'exit 0\n');
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

function runInstaller(args, configDir, extraEnv) {
  return spawnSync(process.execPath, [INSTALLER, ...args, '--config-dir', configDir, '--non-interactive', '--no-mcp-shrink'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, NO_COLOR: '1', ...extraEnv },
    encoding: 'utf8',
  });
}

// A settings.json the JSONC-tolerant reader still cannot parse, so readSettings
// returns null and the hook-removal block is skipped entirely.
const UNPARSEABLE = '{ "hooks": { "SessionStart": [ , ] }';

test('uninstall keeps the hook files when settings.json cannot be updated', () => {
  const dir = freshTmpDir();
  const configDir = path.join(dir, 'claude');
  const env = isolatedEnv(dir);
  try {
    const installed = runInstaller(['--only', 'claude', '--with-hooks'], configDir, env);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const activate = path.join(configDir, 'hooks', 'rocky-activate.js');
    assert.ok(fs.existsSync(activate), 'setup: the hook was never installed');

    fs.writeFileSync(path.join(configDir, 'settings.json'), UNPARSEABLE);
    const removed = runInstaller(['--uninstall'], configDir, env);

    // Deleting the scripts here strands the entries settings.json still holds:
    // Claude Code then dies with `Cannot find module …rocky-activate.js` on
    // every session start (#471).
    assert.ok(fs.existsSync(activate), 'uninstall deleted a hook settings.json may still reference');
    assert.notEqual(removed.status, 0, 'a cleanup that could not finish must not exit 0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Setup puts the CLI under $ROCKY_HOME/cli when the global npm prefix is not
// writable, so an older global rocky can stay first on PATH. Only the newer
// CLI undoes everything it wrote (Auto's model keys), so both run.
test('uninstall does not invoke `rocky` when it is not on PATH', () => {
  const dir = freshTmpDir();
  const configDir = path.join(dir, 'claude');
  const env = isolatedEnv(dir);
  try {
    const installed = runInstaller(['--only', 'claude', '--with-hooks'], configDir, env);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const removed = runInstaller(['--uninstall'], configDir, env);
    assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// An older global `rocky` cannot undo what a newer CLI wrote (1.x left Claude
// Code on the rocky-auto model with no route), so when the CLI this package
// depends on is newer, uninstall runs that one instead.
// The bundled CLI needs a newer Node than the installer (engines >=22.13 vs
// >=18); under npx it is also the `rocky` on PATH. On an older Node it
// crashes or runs unsupported, so uninstall starts no CLI and says why.
// The bundled CLI may not start at all (killed on start, a broken Node). The
// rocky on PATH, even an older one, then takes the turn. A bundled CLI that
// ran and failed keeps its failure: an older CLI cannot undo what the newer one
// wrote, and its exit 0 would hide that.
// `disable --all` deletes `<agent>.json` but keeps the CLI's other records in
// the same directory on purpose. They are not routes; warning about them sent
// users to run `rocky disable --all` forever.
test('uninstall stays quiet when no native integration is journaled', () => {
  const dir = freshTmpDir();
  const configDir = path.join(dir, 'claude');
  const env = isolatedEnv(dir);
  try {
    assert.equal(runInstaller(['--only', 'claude', '--with-hooks'], configDir, env).status, 0);
    const removed = runInstaller(['--uninstall'], configDir, env);
    assert.equal(removed.status, 0, removed.stderr || removed.stdout);
    assert.doesNotMatch(`${removed.stdout}${removed.stderr}`, /rocky disable --all/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A foreign `rocky` whose --version never answers must not stall uninstall:
// the probe gives up after 10s and the PATH rocky keeps its turn.
// Writing settings.json back re-serializes plain JSON: comments and trailing
// commas go. A file with nothing of rocky's in it stays byte-identical, and
// one that does get rewritten keeps its commented original as settings.json.bak.
test('uninstall leaves a settings.json without rocky entries untouched', () => {
  const dir = freshTmpDir();
  const configDir = path.join(dir, 'claude');
  const env = isolatedEnv(dir);
  const settingsPath = path.join(configDir, 'settings.json');
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const mine = '{\n  // my note\n  "model": "opus",\n  "hooks": {},\n  "statusLine": {"type": "command", "command": "~/bin/s.sh",},\n}\n';
    fs.writeFileSync(settingsPath, mine);
    const r = runInstaller(['--uninstall'], configDir, env);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), mine, 'uninstall rewrote a settings.json rocky never touched');
    assert.equal(fs.existsSync(`${settingsPath}.bak`), false);

    const hook = path.join(configDir, 'hooks', 'rocky-activate.js');
    const withHook = `{\n  // my note\n  "hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": ${JSON.stringify(`node ${hook}`)}}]}]},\n}\n`;
    fs.writeFileSync(settingsPath, withHook);
    const r2 = runInstaller(['--uninstall'], configDir, env);
    assert.equal(r2.status, 0, r2.stderr || r2.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {});
    assert.equal(fs.readFileSync(`${settingsPath}.bak`, 'utf8'), withHook, 'commented original not kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("install and uninstall leave another plugin's hooks/package.json alone", () => {
  const dir = freshTmpDir();
  const configDir = path.join(dir, 'claude');
  const env = isolatedEnv(dir);
  const foreign = '{\n  "type": "module",\n  "name": "some-other-plugin"\n}\n';
  try {
    const hooks = path.join(configDir, 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const manifest = path.join(hooks, 'package.json');
    fs.writeFileSync(manifest, foreign);

    const installed = runInstaller(['--only', 'claude', '--with-hooks'], configDir, env);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    assert.equal(fs.readFileSync(manifest, 'utf8'), foreign, 'install overwrote a foreign hooks/package.json');

    runInstaller(['--uninstall'], configDir, env);
    assert.equal(fs.readFileSync(manifest, 'utf8'), foreign, 'uninstall deleted a foreign hooks/package.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Node gives every .js in hooks/ the module type of hooks/package.json. When
// another plugin's manifest says "module", rocky's CommonJS hooks crash on
// every event, so wiring them only adds errors while reporting success.
test("standalone hooks refuse a foreign hooks/package.json that says type:module", () => {
  const dir = freshTmpDir();
  const configDir = path.join(dir, 'claude');
  const env = isolatedEnv(dir);
  try {
    fs.mkdirSync(path.join(configDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'hooks', 'package.json'), '{"type": "module"}\n');
    const r = runInstaller(['--only', 'claude', '--with-hooks'], configDir, env);
    assert.match(r.stderr, /claude-hooks — .*"type":"module"/, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /• claude-hooks/);
    assert.equal(fs.existsSync(path.join(configDir, 'settings.json')), false, 'hooks wired that cannot load');
    assert.equal(fs.existsSync(path.join(configDir, 'hooks', 'rocky-activate.js')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// addCommandHook refuses to overwrite a hook event it does not understand. That
// refusal must come back as a failed claude-hooks, not a stack trace that ends
// the run before the next agent installs.
test('an unsupported hook event shape fails claude-hooks and the run goes on', () => {
  const dir = freshTmpDir();
  const configDir = path.join(dir, 'claude');
  const env = isolatedEnv(dir);
  const settingsPath = path.join(configDir, 'settings.json');
  const odd = '{"hooks": {"SessionStart": {"foo": 1}}}\n';
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(settingsPath, odd);
    const r = runInstaller(['--only', 'claude', '--only', 'grok', '--with-hooks'], configDir, env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /claude-hooks — .*unsupported hook event shape for SessionStart/);
    assert.match(r.stdout, /• grok/, 'agents after Claude Code did not install');
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), odd);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Uninstall takes back the directories install made once they are empty, and
// only those: a directory that was there before install stays, even empty.
test('install then uninstall leaves no empty directories behind', () => {
  const dir = freshTmpDir();
  const configDir = path.join(dir, 'claude');
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'stub-bin');
  try {
    nodeStub(bin, 'opencode', 'process.exit(0);');
    nodeStub(bin, 'npx', 'process.exit(0);');
    const env = { ...stubEnv(isolatedHome(home), bin), CLAUDE_CONFIG_DIR: configDir };
    fs.mkdirSync(path.join(env.OPENCLAW_WORKSPACE, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'opencode', 'themes'), { recursive: true });
    const tree = () => fs.readdirSync(home, { recursive: true }).map(String).sort();
    const before = tree();
    const run = (args) => spawnSync(process.execPath, [INSTALLER, ...args, '--config-dir', configDir, '--non-interactive', '--no-mcp-shrink'], { env, encoding: 'utf8' });
    const installed = run(['--only', 'opencode', '--only', 'cursor', '--only', 'grok', '--only', 'openclaw']);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.ok(fs.existsSync(path.join(env.GROK_HOME, 'skills', 'rocky')), 'setup: grok skills missing');
    const removed = run(['--uninstall']);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.deepEqual(tree(), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
