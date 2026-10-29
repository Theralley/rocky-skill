#!/usr/bin/env node
// Tests for safeWriteFlag / readFlag behavior with symlinked parent directories.
// Covers fix for issue #207: safeWriteFlag refuses flag writes when ~/.claude
// is a symlink.
//
// Run: node tests/test_symlink_flag.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { safeWriteFlag, readFlag, VALID_MODES, writeSessionMode, appendFlag, clearSessionPrev } = require('../src/hooks/rocky-config');

let passed = 0;
let failed = 0;
let skipped = 0;

// Thrown by a test whose precondition this machine can't provide (e.g. an
// unprivileged runner that cannot chown a directory to another user). Skipping
// is only ever acceptable where a source-level guard covers the same invariant
// on every runner — see the "Source code audit" section.
class Skip extends Error {}
function skip(why) { throw new Skip(why); }

function test(name, fn) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-symlink-test-'));
  try {
    fn(tmpBase);
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    if (e instanceof Skip) {
      skipped++;
      console.log(`  ~ ${name} (skipped: ${e.message})`);
    } else {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

console.log('safeWriteFlag + readFlag symlink tests\n');

// ---------- safeWriteFlag ----------

test('writes flag in normal (non-symlinked) directory', (tmp) => {
  const flagDir = path.join(tmp, 'claude-config');
  fs.mkdirSync(flagDir, { recursive: true });
  const flagPath = path.join(flagDir, '.rocky-active');

  safeWriteFlag(flagPath, 'full');

  assert.strictEqual(fs.readFileSync(flagPath, 'utf8'), 'full');
});

test('writes flag when parent directory is a symlink owned by current user', (tmp) => {
  // POSIX-only: Windows lacks getuid/O_NOFOLLOW semantics, so safeWriteFlag
  // fails closed (silently, per the hook invariant) through symlinked parents
  // there — conservative, so the write-succeeds assertions don't apply.
  if (process.platform === 'win32') return; // skip on Windows
  // Create real directory and symlink to it (simulating ~/.claude -> /real/path)
  const realDir = path.join(tmp, 'real-claude-config');
  fs.mkdirSync(realDir, { recursive: true });
  const symlinkDir = path.join(tmp, 'claude-symlink');
  fs.symlinkSync(realDir, symlinkDir);

  const flagPath = path.join(symlinkDir, '.rocky-active');
  safeWriteFlag(flagPath, 'ultra');

  // Flag should exist in the real directory
  const realFlagPath = path.join(realDir, '.rocky-active');
  assert.strictEqual(fs.existsSync(realFlagPath), true, 'flag file should exist in resolved dir');
  assert.strictEqual(fs.readFileSync(realFlagPath, 'utf8'), 'ultra');
});

test('readFlag works through symlinked parent directory', (tmp) => {
  const realDir = path.join(tmp, 'real-claude-config');
  fs.mkdirSync(realDir, { recursive: true });
  const symlinkDir = path.join(tmp, 'claude-symlink');
  fs.symlinkSync(realDir, symlinkDir);

  // Write directly to real path, then read through symlink path
  const realFlagPath = path.join(realDir, '.rocky-active');
  fs.writeFileSync(realFlagPath, 'lite', { mode: 0o600 });

  const result = readFlag(path.join(symlinkDir, '.rocky-active'));
  assert.strictEqual(result, 'rocky', 'legacy "lite" reads back as rocky');
});

test('safeWriteFlag then readFlag round-trip through symlink', (tmp) => {
  if (process.platform === 'win32') return; // skip on Windows (fails closed there)
  const realDir = path.join(tmp, 'real-config');
  fs.mkdirSync(realDir, { recursive: true });
  const symlinkDir = path.join(tmp, 'link-config');
  fs.symlinkSync(realDir, symlinkDir);

  const flagPath = path.join(symlinkDir, '.rocky-active');
  // The longest legacy value still fits under MAX_FLAG_BYTES.
  safeWriteFlag(flagPath, 'wenyan-ultra');

  // Read back through the same symlink path
  const result = readFlag(flagPath);
  assert.strictEqual(result, 'megarocky');
});

test('refuses flag file that is itself a symlink (even through symlinked parent)', (tmp) => {
  const realDir = path.join(tmp, 'real-config');
  fs.mkdirSync(realDir, { recursive: true });
  const symlinkDir = path.join(tmp, 'link-config');
  fs.symlinkSync(realDir, symlinkDir);

  // Create a symlink at the flag file location pointing to some other file
  const decoyFile = path.join(tmp, 'decoy.txt');
  fs.writeFileSync(decoyFile, 'ATTACK');
  const realFlagPath = path.join(realDir, '.rocky-active');
  fs.symlinkSync(decoyFile, realFlagPath);

  // safeWriteFlag should refuse (flag file is a symlink)
  safeWriteFlag(path.join(symlinkDir, '.rocky-active'), 'full');
  // The decoy should NOT have been overwritten
  assert.strictEqual(fs.readFileSync(decoyFile, 'utf8'), 'ATTACK');
});

test('readFlag refuses flag file that is a symlink', (tmp) => {
  const realDir = path.join(tmp, 'real-config');
  fs.mkdirSync(realDir, { recursive: true });

  const secretFile = path.join(tmp, 'secret.txt');
  fs.writeFileSync(secretFile, 'SSH_PRIVATE_KEY_CONTENT');
  fs.symlinkSync(secretFile, path.join(realDir, '.rocky-active'));

  const result = readFlag(path.join(realDir, '.rocky-active'));
  assert.strictEqual(result, null, 'should refuse symlinked flag file');
});

test('flag file permissions are 0600 when written through symlink', (tmp) => {
  if (process.platform === 'win32') return; // skip on Windows

  const realDir = path.join(tmp, 'real-config');
  fs.mkdirSync(realDir, { recursive: true });
  const symlinkDir = path.join(tmp, 'link-config');
  fs.symlinkSync(realDir, symlinkDir);

  safeWriteFlag(path.join(symlinkDir, '.rocky-active'), 'full');

  const realFlagPath = path.join(realDir, '.rocky-active');
  const stat = fs.statSync(realFlagPath);
  const mode = stat.mode & 0o777;
  assert.strictEqual(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
});

test('overwrites existing flag through symlinked parent', (tmp) => {
  if (process.platform === 'win32') return; // skip on Windows (fails closed there)
  const realDir = path.join(tmp, 'real-config');
  fs.mkdirSync(realDir, { recursive: true });
  const symlinkDir = path.join(tmp, 'link-config');
  fs.symlinkSync(realDir, symlinkDir);

  const flagPath = path.join(symlinkDir, '.rocky-active');

  safeWriteFlag(flagPath, 'rocky');
  assert.strictEqual(readFlag(flagPath), 'rocky');

  safeWriteFlag(flagPath, 'ultrarocky');
  assert.strictEqual(readFlag(flagPath), 'ultrarocky');
});

test('creates parent directory via mkdirSync even when it does not exist yet', (tmp) => {
  const flagDir = path.join(tmp, 'nonexistent', 'nested');
  const flagPath = path.join(flagDir, '.rocky-active');

  safeWriteFlag(flagPath, 'full');

  assert.strictEqual(fs.existsSync(flagPath), true);
  assert.strictEqual(fs.readFileSync(flagPath, 'utf8'), 'full');
});

test('symlink to nonexistent target silently fails', (tmp) => {
  const symlinkDir = path.join(tmp, 'broken-link');
  try {
    fs.symlinkSync('/nonexistent/path/that/does/not/exist', symlinkDir);
  } catch (e) {
    // Can't create symlink — skip
    return;
  }

  const flagPath = path.join(symlinkDir, '.rocky-active');
  // Should not throw
  safeWriteFlag(flagPath, 'full');
  // Flag should not exist (target doesn't exist)
  assert.strictEqual(fs.existsSync(path.join(symlinkDir, '.rocky-active')), false);
});

test('all valid modes round-trip through symlinked parent', (tmp) => {
  if (process.platform === 'win32') return; // skip on Windows (fails closed there)
  const realDir = path.join(tmp, 'real-config');
  fs.mkdirSync(realDir, { recursive: true });
  const symlinkDir = path.join(tmp, 'link-config');
  fs.symlinkSync(realDir, symlinkDir);

  const flagPath = path.join(symlinkDir, '.rocky-active');

  for (const mode of VALID_MODES) {
    safeWriteFlag(flagPath, mode);
    const read = readFlag(flagPath);
    assert.strictEqual(read, mode, `mode '${mode}' did not round-trip`);
  }
});

test('every legacy level name reads back as its skill mode', (tmp) => {
  const flagPath = path.join(tmp, '.rocky-active');
  const legacy = {
    lite: 'rocky', full: 'rocky', ultra: 'ultrarocky', wenyan: 'megarocky',
    'wenyan-lite': 'megarocky', 'wenyan-full': 'megarocky', 'wenyan-ultra': 'megarocky',
  };
  for (const [old, mode] of Object.entries(legacy)) {
    fs.writeFileSync(flagPath, old + '\n');
    assert.strictEqual(readFlag(flagPath), mode, old);
  }
  fs.writeFileSync(flagPath, 'manual');
  assert.strictEqual(readFlag(flagPath), null, 'manual is a default policy, never a stored mode');
});

// ---------- rename retry + guaranteed temp cleanup (#511/#578/#657) ----------

test('recovers from transient rename failures within the retry budget', (tmp) => {
  const flagDir = path.join(tmp, 'claude-config');
  fs.mkdirSync(flagDir, { recursive: true });
  const flagPath = path.join(flagDir, '.rocky-active');

  // Simulate a lock held by another process (statusline read, concurrent
  // hook) that clears after two attempts — the third rename should succeed.
  const realRenameSync = fs.renameSync;
  let calls = 0;
  fs.renameSync = (...args) => {
    calls++;
    if (calls < 3) {
      const err = new Error('EBUSY: resource busy or locked');
      err.code = 'EBUSY';
      throw err;
    }
    return realRenameSync(...args);
  };
  try {
    safeWriteFlag(flagPath, 'ultrarocky');
  } finally {
    fs.renameSync = realRenameSync;
  }

  assert.strictEqual(readFlag(flagPath), 'ultrarocky', 'flag should be written once the lock clears');
  const leftovers = fs.readdirSync(flagDir).filter(n => n !== '.rocky-active');
  assert.deepStrictEqual(leftovers, [], 'no temp file should remain after a successful retry');
});

test('gives up silently after 3 failed attempts and leaves no orphaned temp file', (tmp) => {
  const flagDir = path.join(tmp, 'claude-config');
  fs.mkdirSync(flagDir, { recursive: true });
  const flagPath = path.join(flagDir, '.rocky-active');
  fs.writeFileSync(flagPath, 'full');

  const realRenameSync = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('EPERM: operation not permitted');
    err.code = 'EPERM';
    throw err;
  };
  try {
    assert.doesNotThrow(() => safeWriteFlag(flagPath, 'ultra'), 'must silent-fail, never throw');
  } finally {
    fs.renameSync = realRenameSync;
  }

  assert.strictEqual(fs.readFileSync(flagPath, 'utf8'), 'full', 'original flag content untouched');
  const files = fs.readdirSync(flagDir);
  assert.deepStrictEqual(files, ['.rocky-active'], `temp file leaked: ${files}`);
});

test('a non-transient rename error also leaves no orphaned temp file', (tmp) => {
  const flagDir = path.join(tmp, 'claude-config');
  fs.mkdirSync(flagDir, { recursive: true });
  const flagPath = path.join(flagDir, '.rocky-active');

  const realRenameSync = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('ENOSPC: no space left on device');
    err.code = 'ENOSPC'; // not in the transient retry list
    throw err;
  };
  try {
    assert.doesNotThrow(() => safeWriteFlag(flagPath, 'ultra'), 'silent-fail semantics must hold for any error');
  } finally {
    fs.renameSync = realRenameSync;
  }

  const files = fs.readdirSync(flagDir).filter(n => n !== '.rocky-active');
  assert.deepStrictEqual(files, [], 'temp file must be cleaned up even for a non-retried error');
  assert.strictEqual(fs.existsSync(flagPath), false, 'flag was never created');
});

// ---------- win32 junction handling (#1041) ----------

test('write succeeds through a symlinked config dir pointing outside home (win32 branch)', (tmp) => {
  // On win32 there is no uid to compare, so safeWriteFlag takes its second
  // branch. That branch used to require the resolved target to sit under
  // os.homedir() — which a directory junction to another drive never does, so
  // the write was refused through exactly the "legitimate symlinked config
  // dir" case the code says it means to allow. Anyone keeping ~/.claude
  // junctioned off a small system drive silently lost per-turn reinforcement.
  //
  // Node reports a win32 junction as isSymbolicLink(), so dropping
  // process.getuid is a faithful stand-in for that branch on a POSIX runner.
  const target = path.join(tmp, 'other-drive');
  fs.mkdirSync(target, { recursive: true });
  if (path.resolve(target).toLowerCase().startsWith(path.resolve(os.homedir()).toLowerCase() + path.sep)) {
    skip('temp dir lives under $HOME, so the out-of-home case cannot be staged');
  }
  const flagDir = path.join(tmp, 'claude-config');
  fs.symlinkSync(target, flagDir);
  const flagPath = path.join(flagDir, '.rocky-active');

  const realGetuid = process.getuid;
  try {
    delete process.getuid;
    safeWriteFlag(flagPath, 'rocky');
  } finally {
    process.getuid = realGetuid;
  }

  assert.strictEqual(fs.existsSync(flagPath), true,
    'flag must be written through a junction to a writable dir outside home');
  assert.strictEqual(readFlag(flagPath), 'rocky');
});

test('append succeeds through a symlinked config dir pointing outside home (win32 branch)', (tmp) => {
  // appendFlag carries a byte-identical copy of the home-prefix guard that
  // safeWriteFlag used to have, so the junction fix has to land in both or
  // the lifetime stats log ($CLAUDE_CONFIG_DIR/.rocky-history.jsonl) still
  // silently records nothing on a junctioned config dir.
  const target = path.join(tmp, 'other-drive');
  fs.mkdirSync(target, { recursive: true });
  if (path.resolve(target).toLowerCase().startsWith(path.resolve(os.homedir()).toLowerCase() + path.sep)) {
    skip('temp dir lives under $HOME, so the out-of-home case cannot be staged');
  }
  const dir = path.join(tmp, 'claude-config');
  fs.symlinkSync(target, dir);
  const logPath = path.join(dir, '.rocky-history.jsonl');

  const realGetuid = process.getuid;
  try {
    delete process.getuid;
    appendFlag(logPath, JSON.stringify({ mode: 'full' }));
  } finally {
    process.getuid = realGetuid;
  }

  assert.strictEqual(fs.existsSync(logPath), true,
    'append must work through a junction to a writable dir outside home');
  assert.match(fs.readFileSync(logPath, 'utf8'), /"mode":"full"/);
});

test('delete is refused through a symlinked parent owned by another user', (tmp) => {
  // safeWriteFlag refuses to write through a parent symlink owned by someone
  // else. writeSessionMode's legacy-mirror cleanup used a bare fs.unlinkSync,
  // which follows that same symlink happily — so rocky could delete a file
  // it was (correctly) forbidden from creating. Asymmetric guards like this
  // are how a flag ends up destroyed and then impossible to recreate.
  const foreign = path.join(tmp, 'foreign-home');
  fs.mkdirSync(foreign, { recursive: true });
  try {
    fs.chownSync(foreign, 65534, 65534); // nobody
  } catch (e) {
    skip('needs privileges to stage a directory owned by another user');
  }
  if (typeof process.getuid !== 'function' || fs.statSync(foreign).uid === process.getuid()) {
    skip('could not stage a foreign-owned directory');
  }

  const claudeDir = path.join(tmp, 'claude-config');
  fs.symlinkSync(foreign, claudeDir);
  const legacy = path.join(claudeDir, '.rocky-active');

  // Precondition: the write path already refuses this parent.
  safeWriteFlag(legacy, 'full');
  assert.strictEqual(fs.existsSync(legacy), false,
    'precondition: safeWriteFlag must refuse a foreign-owned symlinked parent');

  // Plant a victim file as that other user, then ask for a durable "off",
  // which is what clears the legacy mirror.
  fs.writeFileSync(legacy, 'victim');
  fs.chownSync(legacy, 65534, 65534);
  writeSessionMode(claudeDir, 'abc123def', 'off');

  assert.strictEqual(fs.existsSync(legacy), true,
    'delete must not follow a symlinked parent the write path refuses');
});

test('session prev delete is refused through a symlinked sessions dir owned by another user', (tmp) => {
  // Same asymmetry as the legacy-mirror case above, one level down: the
  // per-session prev file lives under claudeDir/sessions/, and
  // clearSessionPrev used a bare fs.unlinkSync there too.
  const foreign = path.join(tmp, 'foreign-sessions');
  fs.mkdirSync(foreign, { recursive: true });
  try {
    fs.chownSync(foreign, 65534, 65534); // nobody
  } catch (e) {
    skip('needs privileges to stage a directory owned by another user');
  }
  if (typeof process.getuid !== 'function' || fs.statSync(foreign).uid === process.getuid()) {
    skip('could not stage a foreign-owned directory');
  }

  const claudeDir = path.join(tmp, 'claude-config');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.symlinkSync(foreign, path.join(claudeDir, '.rocky-sessions'));
  const prevPath = path.join(foreign, 'abc123def.prev');

  fs.writeFileSync(prevPath, 'victim');
  fs.chownSync(prevPath, 65534, 65534);
  clearSessionPrev(claudeDir, 'abc123def');

  assert.strictEqual(fs.existsSync(prevPath), true,
    'session prev delete must not follow a symlinked sessions dir the write path refuses');
});

// ---------- Source code audit ----------

test('legacy flag delete goes through a guarded helper, not a bare unlinkSync', () => {
  // The behavioral test above needs privileges to stage a foreign-owned dir,
  // so it skips on an ordinary runner. This one holds everywhere: the legacy
  // mirror must never be removed with an unguarded unlinkSync.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'hooks', 'rocky-config.js'), 'utf8'
  );
  assert.ok(/function safeDeleteFlag\s*\(/.test(source),
    'rocky-config.js should define safeDeleteFlag');
  assert.doesNotMatch(source, /fs\.unlinkSync\(legacy\)/,
    'writeSessionMode must not delete the legacy mirror with a bare unlinkSync');
  assert.match(source, /safeDeleteFlag\(legacy\)/,
    'writeSessionMode should clear the legacy mirror via safeDeleteFlag');
});

test('clearSessionPrev goes through a guarded helper, not a bare unlinkSync', () => {
  // Holds on every runner regardless of chown privileges, same reasoning as
  // the legacy-mirror audit above.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'hooks', 'rocky-config.js'), 'utf8'
  );
  const fnMatch = source.match(/function clearSessionPrev\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'clearSessionPrev should be defined');
  const body = fnMatch[0];
  assert.doesNotMatch(body, /fs\.unlinkSync/,
    'clearSessionPrev must not delete either prev file with a bare unlinkSync');
  assert.match(body, /safeDeleteFlag\(/g,
    'clearSessionPrev should clear both prev locations via safeDeleteFlag');
  assert.strictEqual((body.match(/safeDeleteFlag\(/g) || []).length, 2,
    'clearSessionPrev has two delete sites (session-scoped and legacy); both must use safeDeleteFlag');
});

test('safeWriteFlag no longer has blanket symlink parent refusal', (tmp) => {
  // Verify the old pattern "if (fs.lstatSync(flagDir).isSymbolicLink()) return;"
  // without ownership check is no longer present
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'hooks', 'rocky-config.js'), 'utf8'
  );

  // The old pattern: check isSymbolicLink on flagDir and immediately return
  // New pattern: check isSymbolicLink, then realpathSync + ownership verification
  const lines = source.split('\n');
  let foundSymlinkCheck = false;
  let foundOwnershipCheck = false;
  for (const line of lines) {
    if (line.includes('isSymbolicLink()') && line.includes('flagDir')) {
      // This is the lstat check on the parent dir — should NOT be a blanket return
      foundSymlinkCheck = true;
    }
    if (line.includes('realpathSync') || line.includes('getuid') || line.includes('normalizedHome')) {
      foundOwnershipCheck = true;
    }
  }

  assert.ok(foundOwnershipCheck, 'safeWriteFlag should include ownership/home-dir verification');
});

// ---------- Summary ----------

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) process.exit(1);
