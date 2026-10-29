import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fixture(t, source = 'env') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-manual-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'claude');
  fs.mkdirSync(config);
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);
  const env = { ...process.env, HOME: dir, USERPROFILE: dir,
    CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(dir, 'config') };
  delete env.ROCKY_DEFAULT_MODE;
  if (source === 'env') env.ROCKY_DEFAULT_MODE = 'manual';
  if (source === 'repo') fs.writeFileSync(path.join(project, '.rocky.json'), '{"defaultMode":"manual"}');
  if (source === 'user') {
    fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'rocky'), { recursive: true });
    fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, 'rocky/config.json'), '{"defaultMode":"manual"}');
  }
  const mode = () => fs.readFileSync(path.join(config, '.rocky-sessions/test.mode'), 'utf8');
  const run = (script, payload) => {
    const result = spawnSync(process.execPath, [path.join(root, 'src/hooks', script)], {
      // Deliberately outside project: host payload owns configuration scope.
      cwd: dir, env, input: JSON.stringify({ session_id: 'test', cwd: project, ...payload }),
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  return { dir, env, mode, run };
}

for (const source of ['env', 'repo', 'user']) {
  test(`manual ${source} config starts off, activates explicitly, survives resume and resets on clear`, t => {
    const { mode, run } = fixture(t, source);
    assert.equal(run('rocky-activate.js', { source: 'startup' }), 'OK');
    assert.equal(mode(), 'off');
    assert.equal(run('rocky-mode-tracker.js', { prompt: 'ordinary request' }), '');
    assert.match(run('rocky-mode-tracker.js', { prompt: '/rocky status' }), /Rocky mode: off/);
    assert.match(run('rocky-mode-tracker.js', { prompt: '/rocky' }), /ROCKY MODE ACTIVE/);
    assert.equal(mode(), 'rocky');
    for (const source of ['compact', 'resume']) {
      assert.match(run('rocky-activate.js', { source }), /ROCKY MODE ACTIVE/);
      assert.equal(mode(), 'rocky');
    }
    run('rocky-mode-tracker.js', { prompt: '/ultrarocky' });
    run('rocky-mode-tracker.js', { prompt: '/rocky-commit' });
    run('rocky-mode-tracker.js', { prompt: 'continue' });
    assert.equal(mode(), 'ultrarocky');
    run('rocky-mode-tracker.js', { prompt: 'stop rocky' });
    assert.equal(run('rocky-activate.js', { source: 'compact' }), 'OK');
    assert.equal(mode(), 'off');
    run('rocky-mode-tracker.js', { prompt: 'talk like rocky' });
    assert.equal(mode(), 'rocky');
    run('rocky-mode-tracker.js', { prompt: '/megarocky' });
    run('rocky-mode-tracker.js', { prompt: '/rocky-commit' });
    assert.equal(run('rocky-activate.js', { source: 'clear' }), 'OK');
    assert.equal(mode(), 'off');
    run('rocky-mode-tracker.js', { prompt: '/rocky-review' });
    run('rocky-mode-tracker.js', { prompt: 'continue after reset' });
    assert.equal(mode(), 'off', 'one-shot after clear must not resurrect stale megarocky');
  });
}

test('manual remains a config policy, never a stored or selectable mode', t => {
  const { mode, run } = fixture(t);
  run('rocky-activate.js', { source: 'startup' });
  assert.match(run('rocky-mode-tracker.js', { prompt: '/rocky manual' }), /not recognized/);
  assert.equal(mode(), 'off');
});

test('off config still suppresses bare and natural-language activation', t => {
  const { env, mode, run } = fixture(t);
  env.ROCKY_DEFAULT_MODE = 'off';
  run('rocky-activate.js', { source: 'startup' });
  for (const prompt of ['/rocky', 'talk like rocky']) {
    assert.equal(run('rocky-mode-tracker.js', { prompt }), '');
    assert.equal(mode(), 'off');
  }
});

test('missing config module still respects manual startup policy', t => {
  const { dir, env } = fixture(t);
  const hook = path.join(dir, 'rocky-activate.js');
  fs.copyFileSync(path.join(root, 'src/hooks/rocky-activate.js'), hook);
  const result = spawnSync(process.execPath, [hook], {
    cwd: dir, env, input: JSON.stringify({ source: 'startup' }), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});
