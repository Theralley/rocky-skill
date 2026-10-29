// #621 / #672: SessionStart context reaches only the parent thread, so every
// subagent ran without rocky. `rocky-activate.js --subagent` is the
// SubagentStart hook: it hands the subagent THIS session's active skill, and
// nothing at all when the session is off. Read-only: no state writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ACTIVATE = path.join(root, 'src/hooks/rocky-activate.js');
const TRACKER = path.join(root, 'src/hooks/rocky-mode-tracker.js');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-subagent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'claude');
  const project = path.join(dir, 'project');
  fs.mkdirSync(config);
  fs.mkdirSync(project);
  const env = { ...process.env, HOME: dir, USERPROFILE: dir,
    CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(dir, 'xdg') };
  delete env.ROCKY_DEFAULT_MODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const spawnHook = (args, payload) => {
    const result = spawnSync(process.execPath, args, {
      cwd: dir, env, input: JSON.stringify({ session_id: 's1', cwd: project, ...payload }),
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const prompt = (text, sessionId = 's1') =>
    spawnHook([TRACKER], { hook_event_name: 'UserPromptSubmit', prompt: text, session_id: sessionId });
  const subagent = (agentType = 'Explore') => spawnHook([ACTIVATE, '--subagent'],
    { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: agentType });
  return { config, project, env, prompt, subagent };
}

function contextOf(stdout) {
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStart');
  return out.hookSpecificOutput.additionalContext;
}

for (const mode of ['rocky', 'ultrarocky', 'megarocky']) {
  test(`subagent inherits this session's ${mode} skill`, t => {
    const { prompt, subagent } = fixture(t);
    prompt('/' + mode);
    const context = contextOf(subagent());
    assert.match(context, new RegExp(`ROCKY MODE ACTIVE — mode: ${mode}\\b`));
    assert.match(context, new RegExp(`^# ${mode}$`, 'm'), 'the mode\'s own SKILL.md body');
  });
}

test('deactivation does not leak into subagents', t => {
  const { prompt, subagent } = fixture(t);
  prompt('/ultrarocky');
  prompt('stop rocky');
  assert.equal(subagent(), '');
});

test('a session that never activated injects nothing', t => {
  const { subagent } = fixture(t);
  assert.equal(subagent(), '');
});

test('another window\'s mode does not reach a session that stored off', t => {
  const { prompt, subagent } = fixture(t);
  prompt('stop rocky');
  // A second window turns ultrarocky on, which also rewrites the legacy mirror.
  prompt('/ultrarocky', 's2');
  assert.equal(subagent(), '');
});

// Documented degrade, not a leak to fix here: a session with NO stored state
// (SessionStart skipped or failed, or the session predates the store) reads
// the legacy mirror through resolveActiveMode, exactly like the tracker's
// per-turn reinforcement for the parent thread. Subagents match their parent.
test('a session with no stored state falls back to the legacy mirror, like its parent thread', t => {
  const { prompt, subagent } = fixture(t);
  prompt('/ultrarocky', 's2');
  assert.match(contextOf(subagent()), /mode: ultrarocky\b/);
  assert.match(prompt('hello'), /ultrarocky/i, 'the tracker reinforces the same mirrored mode');
});

for (const agentType of ['rocky:rockycrew-investigator', 'rockycrew-builder']) {
  test(`${agentType} keeps its own voice`, t => {
    const { prompt, subagent } = fixture(t);
    prompt('/rocky');
    assert.equal(subagent(agentType), '');
  });
}

test('one-shot modes are not pushed into subagents', t => {
  const { prompt, subagent } = fixture(t);
  prompt('/rocky');
  prompt('/rocky-commit');
  assert.equal(subagent(), '');
});

test('repo-local defaultMode off opts the project out (#634)', t => {
  const { config, project, subagent } = fixture(t);
  fs.mkdirSync(path.join(config, '.rocky-sessions'));
  fs.writeFileSync(path.join(config, '.rocky-sessions/s1.mode'), 'rocky');
  fs.writeFileSync(path.join(project, '.rocky.json'), '{"defaultMode":"off"}');
  assert.equal(subagent(), '');
});

test('subagent path writes nothing', t => {
  const { config, prompt, subagent } = fixture(t);
  prompt('/ultrarocky');
  const snapshot = () => {
    const files = {};
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files[path.relative(config, p)] = fs.readFileSync(p, 'utf8') + '@' + fs.statSync(p).mtimeMs;
      }
    };
    walk(config);
    return files;
  };
  const before = snapshot();
  contextOf(subagent());
  assert.deepEqual(snapshot(), before);
});

test('returns on the first complete payload while the host holds stdin open', async t => {
  const { env, project, prompt } = fixture(t);
  prompt('/ultrarocky');
  const started = Date.now();
  const child = spawn(process.execPath, [ACTIVATE, '--subagent'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stdin.write(JSON.stringify({ session_id: 's1', cwd: project, hook_event_name: 'SubagentStart', agent_type: 'Explore' }));
  const code = await new Promise((resolve) => {
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.on('exit', (c) => { clearTimeout(killer); resolve(c); });
  });
  t.after(() => { try { child.stdin.destroy(); } catch (e) {} });
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started}ms with stdin held open`);
  assert.match(contextOf(stdout), /mode: ultrarocky/);
});
