#!/usr/bin/env node
// Tests for the shared mode-change parser (#602), src/hooks/rocky-parse.js.
// rocky-mode-tracker.js and the opencode plugin both consume this module —
// these tests exercise it directly (unit-level) and also check that its
// verdicts line up with what the real tracker.js hook does for the same
// prompts (parity), so the two callers can't silently drift apart again.
//
// Run: node tests/test_rocky_parse.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

const { parseModeChange, INDEPENDENT_MODES } = require('../src/hooks/rocky-parse');

const HOOK_PATH = path.resolve(__dirname, '..', 'src', 'hooks', 'rocky-mode-tracker.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

console.log('rocky-parse (shared mode-change parser) tests\n');

const defaultRocky = { getDefaultMode: () => 'rocky' };
const defaultOff = { getDefaultMode: () => 'off' };
const MODE_OF = {
  '/ultrarocky': 'ultrarocky', '/rocky:ultrarocky': 'ultrarocky',
  '/megarocky': 'megarocky', '/rocky:megarocky': 'megarocky',
};

test('status uses one read-only verdict for literal and expanded commands', () => {
  const options = { getDefaultMode: () => { throw new Error('status must not resolve a default'); } };
  for (const prompt of ['/rocky status', '/rocky:rocky status', '/rocky status.']) {
    assert.deepStrictEqual(parseModeChange(prompt, options), { action: 'status' });
  }
  assert.deepStrictEqual(parseModeChange('Activate rocky mode: status\n\nIf no argument given, use rocky.', {
    ...options, expandedTpl: true,
  }), { action: 'status' });
  assert.strictEqual(parseModeChange('What does `/rocky status` do?', options), null);
});

test('manual startup policy permits explicit activation but is not a mode', () => {
  const options = { getDefaultMode: () => 'manual', expandedTpl: true };
  for (const prompt of ['/rocky', 'talk like rocky', 'Activate rocky mode: \n\nIf no argument given, use rocky.']) {
    assert.deepStrictEqual(parseModeChange(prompt, options), { action: 'set', mode: 'rocky' });
  }
  assert.deepStrictEqual(parseModeChange('/rocky manual', options), { action: 'unresolved' });
  assert.strictEqual(parseModeChange('ordinary request', options), null);
});

// ---------- basic unit coverage ----------

test('empty/whitespace prompt is a no-op', () => {
  assert.strictEqual(parseModeChange('', defaultRocky), null);
  assert.strictEqual(parseModeChange('   ', defaultRocky), null);
});

test('/ultrarocky and /megarocky set their own mode, bare or namespaced', () => {
  for (const [prompt, mode] of [
    ['/ultrarocky', 'ultrarocky'], ['/rocky:ultrarocky', 'ultrarocky'],
    ['/megarocky', 'megarocky'], ['/rocky:megarocky', 'megarocky'],
  ]) {
    assert.deepStrictEqual(parseModeChange(prompt, defaultRocky), { action: 'set', mode }, prompt);
    // A configured default never overrides the command's own mode.
    assert.deepStrictEqual(parseModeChange(prompt, defaultOff), { action: 'set', mode }, prompt);
  }
});

test('/rocky <arg> accepts the three mode names', () => {
  for (const mode of ['rocky', 'ultrarocky', 'megarocky']) {
    assert.deepStrictEqual(parseModeChange('/rocky ' + mode, defaultRocky), { action: 'set', mode });
  }
});

test('legacy level names still parse as aliases of the three modes', () => {
  for (const [arg, mode] of [
    ['lite', 'rocky'], ['full', 'rocky'], ['ultra', 'ultrarocky'],
    ['wenyan', 'megarocky'], ['wenyan-lite', 'megarocky'],
    ['wenyan-full', 'megarocky'], ['wenyan-ultra', 'megarocky'],
  ]) {
    assert.deepStrictEqual(parseModeChange('/rocky ' + arg, defaultRocky), { action: 'set', mode }, arg);
  }
});

test('/ultrarocky and /megarocky take the same off/status words as /rocky', () => {
  for (const cmd of ['/ultrarocky', '/rocky:ultrarocky', '/megarocky', '/rocky:megarocky']) {
    for (const word of ['off', 'stop', 'disable', 'off.']) {
      assert.deepStrictEqual(parseModeChange(`${cmd} ${word}`, defaultRocky), { action: 'clear' }, `${cmd} ${word}`);
    }
    assert.deepStrictEqual(parseModeChange(`${cmd} status`, defaultRocky), { action: 'status' }, `${cmd} status`);
    assert.deepStrictEqual(
      parseModeChange(`${cmd} please`, defaultRocky),
      { action: 'set', mode: MODE_OF[cmd] },
      `${cmd} please`
    );
  }
});

test('/ultrarocky-like prefixes are not the command', () => {
  assert.strictEqual(parseModeChange('/ultrarockyman', defaultRocky), null);
  assert.strictEqual(parseModeChange('/megarocky-stats', defaultRocky), null);
});

test('bare /rocky activates at the configured default', () => {
  assert.deepStrictEqual(parseModeChange('/rocky', defaultRocky), { action: 'set', mode: 'rocky' });
});

test('bare /rocky with an off default clears instead of setting mode "off"', () => {
  assert.deepStrictEqual(parseModeChange('/rocky', defaultOff), { action: 'clear' });
});

test('/rocky off|stop|disable all clear', () => {
  assert.deepStrictEqual(parseModeChange('/rocky off', defaultRocky), { action: 'clear' });
  assert.deepStrictEqual(parseModeChange('/rocky stop', defaultRocky), { action: 'clear' });
  assert.deepStrictEqual(parseModeChange('/rocky disable', defaultRocky), { action: 'clear' });
});

// A bogus level is now REPORTED rather than swallowed (#838), but the original
// danger these two guard against is unchanged: it must never activate the
// default. 'unresolved' carries no mode, and applyModeChange/the tracker act
// only on 'set'/'clear'.
test('bogus level is unresolved — never falls through to the default', () => {
  const verdict = parseModeChange('/rocky not-a-real-level', defaultRocky);
  assert.deepStrictEqual(verdict, { action: 'unresolved' });
  assert.strictEqual(verdict.mode, undefined, 'must not carry a mode');
});

test('independent modes are not reachable via /rocky <arg>', () => {
  const verdict = parseModeChange('/rocky commit', defaultRocky);
  assert.strictEqual(verdict.action, 'unresolved');
  assert.strictEqual(verdict.mode, undefined, 'must not activate the mode');
});

// #838: punctuation glued to the level matched no mode, left the level
// untouched, and said nothing. Only parts[1] is read, so trailing WORDS were
// already harmless — it is the glued character that broke it.
test('punctuation glued to the level still resolves (#838)', () => {
  for (const prompt of ['/rocky ultra;', '/rocky ultra.', '/rocky ultra!', '/rocky ultra,']) {
    assert.deepStrictEqual(parseModeChange(prompt, defaultRocky), { action: 'set', mode: 'ultrarocky' }, prompt);
  }
});

test('punctuation glued to a hyphenated level still resolves (#838)', () => {
  assert.deepStrictEqual(
    parseModeChange('/rocky wenyan-ultra.', defaultRocky),
    { action: 'set', mode: 'megarocky' }
  );
  assert.deepStrictEqual(
    parseModeChange('/rocky wenyan-full,', defaultRocky),
    { action: 'set', mode: 'megarocky' }
  );
});

test('punctuation glued to off still deactivates (#838)', () => {
  assert.deepStrictEqual(parseModeChange('/rocky off.', defaultRocky), { action: 'clear' });
});

test('trailing words after the level remain harmless', () => {
  assert.deepStrictEqual(
    parseModeChange('/rocky ultra; still too verbose', defaultRocky),
    { action: 'set', mode: 'ultrarocky' }
  );
});

// `/rocky ?` is plausibly someone asking for help. Bare `/rocky` still
// activates; an argument that was PRESENT but normalized away must not.
test('a punctuation-only argument does not activate', () => {
  assert.deepStrictEqual(parseModeChange('/rocky ?', defaultRocky), { action: 'unresolved' });
  assert.deepStrictEqual(parseModeChange('/rocky', defaultRocky), { action: 'set', mode: 'rocky' });
});

test('/rocky-commit, /rocky-review, /rocky-compress set independent modes', () => {
  assert.deepStrictEqual(parseModeChange('/rocky-commit', defaultRocky), { action: 'set', mode: 'commit' });
  assert.deepStrictEqual(parseModeChange('/rocky-review', defaultRocky), { action: 'set', mode: 'review' });
  assert.deepStrictEqual(parseModeChange('/rocky-compress', defaultRocky), { action: 'set', mode: 'compress' });
});

test('namespaced /rocky:rocky-* variants are recognized', () => {
  assert.deepStrictEqual(parseModeChange('/rocky:rocky-commit', defaultRocky), { action: 'set', mode: 'commit' });
  assert.deepStrictEqual(parseModeChange('/rocky:rocky-review', defaultRocky), { action: 'set', mode: 'review' });
  assert.deepStrictEqual(parseModeChange('/rocky:rocky', defaultRocky), { action: 'set', mode: 'rocky' });
});

test('natural-language activation', () => {
  assert.deepStrictEqual(parseModeChange('activate rocky', defaultRocky), { action: 'set', mode: 'rocky' });
  assert.deepStrictEqual(parseModeChange('talk like a rocky', defaultRocky), { action: 'set', mode: 'rocky' });
});

test('brevity triggers activate', () => {
  assert.deepStrictEqual(parseModeChange('be brief', defaultRocky), { action: 'set', mode: 'rocky' });
  assert.deepStrictEqual(parseModeChange('fewer tokens please', defaultRocky), { action: 'set', mode: 'rocky' });
});

test('scoped brevity ("be brief in the summary") does not activate', () => {
  assert.strictEqual(parseModeChange('be brief in the summary section', defaultRocky), null);
});

test('questions about rocky do not activate', () => {
  assert.strictEqual(parseModeChange('what is rocky mode?', defaultRocky), null);
});

// #187: the gap between the activation verb and "rocky" was any 40
// characters, so ordinary prose that merely mentioned rocky downstream of a
// common verb switched the mode on. The gap is a whitelist of determiners and
// particles now.
test('prose with a verb and a downstream "rocky" does not activate (#187)', () => {
  for (const prompt of [
    'i want to start building a rocky-themed game',
    'help me start a rocky fire for the demo scene',
    'we should use the sprite sheet from the rocky assets folder',
    'switch to the branch that renames the rocky skill directory',
  ]) {
    assert.strictEqual(parseModeChange(prompt, defaultRocky), null, prompt);
  }
});

test('real activation phrasings still activate (positive control, #187)', () => {
  for (const prompt of [
    'activate rocky',
    'activate rocky mode',
    'enable the rocky mode',
    'turn on rocky',
    'turn on the rocky mode please',
    'switch to rocky',
    'i want rocky mode',
    'give me rocky',
    'please use rocky now',
    'talk like rocky',
    'talk like a rocky',
  ]) {
    assert.deepStrictEqual(parseModeChange(prompt, defaultRocky), { action: 'set', mode: 'rocky' }, prompt);
  }
});

// #187: "don't activate rocky" activated. The guard is activation-only —
// see the asymmetry note in rocky-parse.js and the #838 test below, which
// keeps "don't stop rocky" deactivating on purpose.
test('a negated activation does not activate (#187)', () => {
  for (const prompt of [
    "don't activate rocky",
    'do not turn on rocky',
    'never enable rocky mode',
    "i don't want rocky for this file",
    "please don't talk like a rocky",
    'no need to use rocky here',
  ]) {
    assert.strictEqual(parseModeChange(prompt, defaultRocky), null, prompt);
  }
});

// The negator does not always sit next to the verb it negates: "don't want you
// to use rocky" negates `want`, while the trigger that actually matches is
// the `use` in the complement clause. Scoping the guard to the clause rather
// than to a fixed word window is what catches these.
test('a negated activation with a complement clause does not activate (#187)', () => {
  for (const prompt of [
    "i don't want you to use rocky",
    "don't ask me to enable rocky",
    "please don't switch me to rocky",
    "i don't need you to talk like a rocky",
    'never ask me to turn on rocky mode',
  ]) {
    assert.strictEqual(parseModeChange(prompt, defaultRocky), null, prompt);
  }
});

// The other half of clause scoping: a negation must not swallow a LATER,
// independent positive command. Widening the guard to "a negator appears
// anywhere earlier in the prompt" would break exactly these.
test('a negated clause does not suppress a later activation (#187)', () => {
  for (const prompt of [
    "don't use vim, activate rocky",
    "i don't like verbose output. activate rocky",
    "never mind the linter — turn on rocky",
  ]) {
    assert.deepStrictEqual(parseModeChange(prompt, defaultRocky), { action: 'set', mode: 'rocky' }, prompt);
  }
});

test('natural-language deactivation', () => {
  assert.deepStrictEqual(parseModeChange('turn rocky mode off', defaultRocky), { action: 'clear' });
  assert.deepStrictEqual(parseModeChange('normal mode', defaultRocky), { action: 'clear' });
});

// "go back to normal mode" and "go to normal mode" are ordinary switch-back
// phrasings, but the verb alternation listed "go" and "back to" as separate,
// mutually exclusive prefixes, so "go back to" matched nothing and "go to" had
// no alternative at all. Both deactivations were silently dropped, leaving the
// user in the mode with no feedback.
test('"go back to normal mode" / "go to normal mode" deactivate like the other switch-back phrasings', () => {
  for (const prompt of [
    'go back to normal mode',
    'go to normal mode',
    'please go back to normal mode',
    'go back to normal mode and summarize the diff',
  ]) {
    assert.deepStrictEqual(parseModeChange(prompt, defaultRocky), { action: 'clear' }, prompt);
  }
});

test('vim "normal mode" (no rocky context) does not deactivate', () => {
  assert.strictEqual(parseModeChange('how do I exit vim normal mode', defaultRocky), null);
});

test('INDEPENDENT_MODES is exported and matches the known set', () => {
  assert.deepStrictEqual([...INDEPENDENT_MODES].sort(), ['commit', 'compress', 'review']);
});

// ---------- skipNaturalLanguage (foreign command envelopes, #537) ----------

test('skipNaturalLanguage suppresses activation/deactivation matching entirely', () => {
  assert.strictEqual(
    parseModeChange('please activate rocky mode now', { ...defaultRocky, skipNaturalLanguage: true }),
    null
  );
  assert.strictEqual(
    parseModeChange('stop rocky', { ...defaultRocky, skipNaturalLanguage: true }),
    null
  );
});

test('skipNaturalLanguage still lets literal slash commands through', () => {
  assert.deepStrictEqual(
    parseModeChange('/rocky ultra', { ...defaultRocky, skipNaturalLanguage: true }),
    { action: 'set', mode: 'ultrarocky' }
  );
});

// ---------- unwrapQuotes (opencode `run` path) ----------

test('unwrapQuotes strips a symmetric quote wrapper before matching', () => {
  assert.deepStrictEqual(
    parseModeChange('"/rocky lite"', { ...defaultRocky, unwrapQuotes: true }),
    { action: 'set', mode: 'rocky' }
  );
});

test('without unwrapQuotes, a quoted command does not match', () => {
  assert.strictEqual(parseModeChange('"/rocky lite"', defaultRocky), null);
});

// ---------- expandedTpl (opencode's expanded command-template bodies) ----------

test('expandedTpl recognizes the ultrarocky and megarocky templates', () => {
  const read = (name) => fs.readFileSync(
    path.join(__dirname, '..', 'src', 'plugins', 'opencode', 'commands', name), 'utf8',
  ).replace(/^---[\s\S]*?---\s*/, '');
  assert.deepStrictEqual(
    parseModeChange(read('ultrarocky.md'), { ...defaultRocky, expandedTpl: true }),
    { action: 'set', mode: 'ultrarocky' }
  );
  assert.deepStrictEqual(
    parseModeChange(read('megarocky.md'), { ...defaultRocky, expandedTpl: true }),
    { action: 'set', mode: 'megarocky' }
  );
  assert.deepStrictEqual(
    parseModeChange(read('rocky.md').replace('$ARGUMENTS', ''), { ...defaultRocky, expandedTpl: true }),
    { action: 'set', mode: 'rocky' }
  );
});

test('expandedTpl recognizes the generic "/rocky <arg>" template', () => {
  assert.deepStrictEqual(
    parseModeChange('Activate rocky mode: ultra', { ...defaultRocky, expandedTpl: true }),
    { action: 'set', mode: 'ultrarocky' }
  );
});

test('expandedTpl: empty level (bare "/rocky", multi-line template head) uses the default', () => {
  // The real commands/rocky.md template puts `Activate rocky mode:
  // $ARGUMENTS` on its own line, followed by a blank line and then fixed
  // boilerplate ("If no argument given, use rocky. If \"off\", deactivate.").
  // With $ARGUMENTS empty, whitespace-collapse used to merge that boilerplate
  // directly onto the same line as the (empty) argument, so the word "if"
  // (from "If no level given ...") was captured as the level and rejected as
  // bogus — a bare `/rocky` in opencode silently never activated.
  // Regression guard for that (matches the shape exercised by
  // tests/installer/opencode.test.mjs's real-hooks test).
  const templateNoArgs =
    'Activate rocky mode: \n\n' +
    'If no argument given, use rocky. If "off", deactivate.';
  assert.deepStrictEqual(
    parseModeChange(templateNoArgs, { ...defaultRocky, expandedTpl: true }),
    { action: 'set', mode: 'rocky' }
  );
});

test('expandedTpl: bogus level in the template is unresolved, not the default (#602 drift)', () => {
  assert.deepStrictEqual(
    parseModeChange('Activate rocky mode: not-a-real-level', { ...defaultRocky, expandedTpl: true }),
    { action: 'unresolved' }
  );
});

test('expandedTpl recognizes the independent-mode command templates (#602 drift)', () => {
  assert.deepStrictEqual(
    parseModeChange('Generate a commit message for the current staged changes.', { ...defaultRocky, expandedTpl: true }),
    { action: 'set', mode: 'commit' }
  );
  assert.deepStrictEqual(
    parseModeChange('Review the current diff (or files: ).', { ...defaultRocky, expandedTpl: true }),
    { action: 'set', mode: 'review' }
  );
  assert.deepStrictEqual(
    parseModeChange('Compress the file at: notes.md', { ...defaultRocky, expandedTpl: true }),
    { action: 'set', mode: 'compress' }
  );
});

test('expandedTpl: no non-activation opencode template switches a prose mode', () => {
  // Every shipped command file, expanded the way opencode delivers it: front
  // matter stripped, $ARGUMENTS empty. /rocky-help listed "Activate rocky"
  // in its table, which flipped ultrarocky back to rocky (or turned it on).
  const dir = path.join(__dirname, '..', 'src', 'plugins', 'opencode', 'commands');
  const PROSE = new Set(['rocky', 'ultrarocky', 'megarocky']);
  const checked = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    if (PROSE.has(file.replace(/\.md$/, ''))) continue; // activation templates by design
    const body = fs.readFileSync(path.join(dir, file), 'utf8')
      .replace(/^---[\s\S]*?---\s*/, '').split('$ARGUMENTS').join('');
    for (const getDefaultMode of [() => 'rocky', () => 'ultrarocky']) {
      const verdict = parseModeChange(body, { getDefaultMode, expandedTpl: true, unwrapQuotes: true });
      const switches = verdict && (verdict.action === 'clear' || (verdict.action === 'set' && PROSE.has(verdict.mode)));
      assert.ok(!switches, `${file} → ${JSON.stringify(verdict)}`);
    }
    checked.push(file);
  }
  for (const f of ['rocky-help.md', 'rocky-commit.md', 'rocky-review.md', 'rocky-compress.md', 'rocky-stats.md']) {
    assert.ok(checked.includes(f), `${f} not checked`);
  }
});

test('expandedTpl: the help card opener short-circuits even a trigger in its body', () => {
  assert.strictEqual(
    parseModeChange('Show the rocky quick-reference card.\n\n| /rocky | Activate rocky |\nstop rocky', {
      ...defaultRocky, expandedTpl: true,
    }),
    null
  );
});

test('without expandedTpl, template bodies are inert plain text', () => {
  assert.strictEqual(
    parseModeChange('Generate a commit message for the current staged changes.', defaultRocky),
    null
  );
});

// ---------- parity with the real tracker hook ----------
// The tracker collapses whitespace/case and applies the same option set this
// module expects (getDefaultMode, skipNaturalLanguage). For a representative
// set of raw prompts, verify the flag-file outcome the tracker produces
// matches what parseModeChange's verdict implies — proving the two stay in
// sync rather than just "both look right in isolation".

function runTracker(prompt, presetFlag) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-parse-parity-'));
  try {
    if (presetFlag) fs.writeFileSync(path.join(cfg, '.rocky-active'), presetFlag);
    spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({ prompt }),
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const flagPath = path.join(cfg, '.rocky-active');
    return fs.existsSync(flagPath) ? fs.readFileSync(flagPath, 'utf8') : null;
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
}

// #838: natural-language triggers ran over the whole prompt, so any pasted
// text that merely QUOTED them fired them.
test('prose quoting "stop rocky" no longer deactivates (#838)', () => {
  const prompt = 'why does the help card say "stop rocky" or "normal mode" here?';
  assert.strictEqual(parseModeChange(prompt, defaultRocky), null);
});

test('prose quoting "activate rocky" no longer activates (#838)', () => {
  assert.strictEqual(
    parseModeChange('the readme says you can "activate rocky" by typing it', defaultRocky),
    null
  );
});

test('backtick-quoted triggers are inert too', () => {
  assert.strictEqual(parseModeChange('the `stop rocky` phrase is documented', defaultRocky), null);
});

// The cap that was tried first broke exactly these: a user explaining WHY they
// want the mode off writes more words, not fewer, and a dropped deactivation
// is silent — the user cannot escape and is told nothing.
test('long compound deactivation still works — no length cap (#838)', () => {
  for (const prompt of [
    'that is enough compression for now — please turn off rocky mode and go back to full plain sentences for the rest of this task',
    'ok this is getting hard to read, stop rocky mode and then go through the auth middleware and explain the token expiry check again',
  ]) {
    assert.ok(prompt.length > 120, 'fixture must be long enough to matter');
    assert.deepStrictEqual(parseModeChange(prompt, defaultRocky), { action: 'clear' }, prompt);
  }
});

test('long compound activation still works', () => {
  const prompt = 'activate rocky mode and then start by reading the proxy package and summarising how the dial guard is wired up today';
  assert.ok(prompt.length > 110);
  assert.deepStrictEqual(parseModeChange(prompt, defaultRocky), { action: 'set', mode: 'rocky' });
});

test('apostrophes do not blank the command ("don\'t stop rocky, it\'s useful")', () => {
  assert.deepStrictEqual(
    parseModeChange("don't stop rocky, it's useful", defaultRocky),
    { action: 'clear' }
  );
});

test('short natural-language triggers still work (positive control)', () => {
  assert.deepStrictEqual(parseModeChange('stop rocky', defaultRocky), { action: 'clear' });
  assert.deepStrictEqual(parseModeChange('back to normal mode please', defaultRocky), { action: 'clear' });
  assert.deepStrictEqual(parseModeChange('activate rocky', defaultRocky), { action: 'set', mode: 'rocky' });
});

// A foreign slash command's own text must not toggle our mode — symmetric with
// the skipNaturalLanguage that a foreign command ENVELOPE already sets.
test('a slash-initiated prompt does not fire natural-language triggers', () => {
  assert.strictEqual(parseModeChange('/rocky-help stop rocky', defaultRocky), null);
  assert.strictEqual(parseModeChange('/some-other-command activate rocky', defaultRocky), null);
});

test('slash commands themselves are unaffected by prompt length', () => {
  const long = '/rocky ultra ' + 'x'.repeat(400);
  assert.deepStrictEqual(parseModeChange(long, defaultRocky), { action: 'set', mode: 'ultrarocky' });
});

// An independent mode IS a real mode, just not reachable this way — saying
// "not recognized" would deny a mode the user can see in the docs.
test('an independent mode via /rocky <arg> reports its own command', () => {
  assert.deepStrictEqual(
    parseModeChange('/rocky commit', defaultRocky),
    { action: 'unresolved', independentMode: 'commit' }
  );
});

test('a quoted level resolves (leading punctuation stripped too)', () => {
  assert.deepStrictEqual(parseModeChange('/rocky "ultra"', defaultRocky), { action: 'set', mode: 'ultrarocky' });
});

const parityCases = [
  { prompt: '/rocky ultra', preset: null },
  { prompt: '/ultrarocky', preset: 'rocky' },
  { prompt: '/rocky off', preset: 'rocky' },
  { prompt: '/rocky not-a-real-level', preset: 'ultrarocky' },
  { prompt: 'be brief', preset: null },
  { prompt: 'activate rocky', preset: null },
  { prompt: 'stop rocky', preset: 'rocky' },
  { prompt: 'what is rocky mode?', preset: null },
];

for (const { prompt, preset } of parityCases) {
  test(`parity: "${prompt}" (preset=${preset}) matches shared-parser verdict`, () => {
    const normalized = prompt.trim().toLowerCase().replace(/\s+/g, ' ');
    const verdict = parseModeChange(normalized, { getDefaultMode: () => 'rocky' });
    // null and 'unresolved' both mean "leave the flag exactly as it was".
    const expected =
      verdict === null ? (preset || null) :
      verdict.action === 'unresolved' ? (preset || null) :
      verdict.action === 'clear' ? null :
      verdict.mode;
    assert.strictEqual(runTracker(prompt, preset), expected);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
