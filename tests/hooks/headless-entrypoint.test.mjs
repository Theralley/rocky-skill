// #377: headless `claude -p` and Agent SDK sessions are often tool probes that
// parse the reply (CodexBar and similar). Claude Code tells hooks how a session
// started through CLAUDE_CODE_ENTRYPOINT; sdk-* entrypoints start under the
// manual policy, interactive surfaces (cli, claude-vscode, claude-desktop, ...)
// are untouched, and an explicit ROCKY_DEFAULT_MODE opts back in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fixture(t, extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-headless-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'claude');
  fs.mkdirSync(config);
  const env = { ...process.env, HOME: dir, USERPROFILE: dir,
    CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(dir, 'config') };
  delete env.ROCKY_DEFAULT_MODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  Object.assign(env, extraEnv);
  const mode = () => fs.readFileSync(path.join(config, '.rocky-sessions/h1.mode'), 'utf8');
  const run = (script, payload) => {
    const result = spawnSync(process.execPath, [path.join(root, 'src/hooks', script)], {
      cwd: dir, env, input: JSON.stringify({ session_id: 'h1', cwd: dir, ...payload }),
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  return { mode, run };
}

for (const entrypoint of ['sdk-cli', 'sdk-ts', 'sdk-py']) {
  test(`${entrypoint} session starts off and explicit /rocky still activates`, t => {
    const { mode, run } = fixture(t, { CLAUDE_CODE_ENTRYPOINT: entrypoint });
    assert.equal(run('rocky-activate.js', { source: 'startup' }), 'OK');
    assert.equal(mode(), 'off');
    assert.equal(run('rocky-mode-tracker.js', { prompt: 'say hi' }), '', 'no per-turn reinforcement');
    assert.match(run('rocky-mode-tracker.js', { prompt: '/rocky' }), /ROCKY MODE ACTIVE/);
    assert.equal(mode(), 'rocky');
  });
}

test('headless fork with no stored state also starts off', t => {
  const { mode, run } = fixture(t, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
  assert.equal(run('rocky-activate.js', { source: 'fork' }), 'OK');
  assert.equal(mode(), 'off');
});

for (const entrypoint of ['cli', 'claude-vscode', 'claude-desktop']) {
  test(`${entrypoint} session still gets the ruleset`, t => {
    const { mode, run } = fixture(t, { CLAUDE_CODE_ENTRYPOINT: entrypoint });
    assert.match(run('rocky-activate.js', { source: 'startup' }), /ROCKY MODE ACTIVE/);
    assert.equal(mode(), 'rocky');
  });
}

test('explicit ROCKY_DEFAULT_MODE opts a headless session back in', t => {
  const { mode, run } = fixture(t, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', ROCKY_DEFAULT_MODE: 'ultrarocky' });
  assert.match(run('rocky-activate.js', { source: 'startup' }), /ROCKY MODE ACTIVE — mode: ultrarocky/);
  assert.equal(mode(), 'ultrarocky');
});
