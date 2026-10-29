#!/bin/bash
# rocky — uninstaller for the SessionStart + SubagentStart + UserPromptSubmit + SessionEnd hooks
# Removes: hook files in ~/.claude/hooks, settings.json entries, and the mode state
# Usage: bash src/hooks/uninstall.sh
#   or:  bash <(curl -s https://raw.githubusercontent.com/Theralley/rocky-skill/main/src/hooks/uninstall.sh)
set -e

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
HOOKS_DIR="$CLAUDE_DIR/hooks"
SETTINGS="$CLAUDE_DIR/settings.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
SETTINGS_HELPER=""
BACKUP_MADE=0
if [ -f "$SCRIPT_DIR/../../installer/lib/settings.js" ]; then
  SETTINGS_HELPER="$SCRIPT_DIR/../../installer/lib/settings.js"
fi

HOOK_FILES=("package.json" "rocky-config.js" "rocky-parse.js" "rocky-activate.js" "rocky-mode-tracker.js" "rocky-stats.js" "rocky-statusline.sh" "rockycrew-model-overrides.js")

# Detect if rocky is installed as a plugin (check plugin cache)
PLUGIN_INSTALLED=0
if [ -d "$CLAUDE_DIR/plugins" ]; then
  if find "$CLAUDE_DIR/plugins" -path "*/rocky*" -name "plugin.json" -print -quit 2>/dev/null | grep -q .; then
    PLUGIN_INSTALLED=1
  fi
fi

if [ "$PLUGIN_INSTALLED" -eq 1 ]; then
  echo "Rocky appears to be installed as a Claude Code plugin."
  echo "To uninstall the plugin, run:"
  echo ""
  echo "  claude plugin disable rocky"
  echo ""
  echo "This script removes standalone hooks (installed via install.sh)."
  echo "Continuing with standalone hook removal..."
  echo ""
fi

echo "Uninstalling rocky hooks..."

# 1. Remove rocky entries from settings.json (idempotent)
#
# This runs BEFORE the hook files are deleted, on purpose. If the settings edit
# cannot complete, the install is still intact and the user can re-run or edit
# by hand. The other order left Claude Code pointing at deleted scripts, which
# is `Cannot find module …rocky-activate.js` on every session start (#471).
if [ -f "$SETTINGS" ]; then
  # Require node for the same reason install.sh does — safe JSON editing
  if ! command -v node >/dev/null 2>&1; then
    # Abort — do NOT fall through to deleting the hook files. settings.json
    # still points at them, and removing them is exactly #471 on every
    # session start. Same reason the node -e failure above exits non-zero.
    echo "ERROR: 'node' not found — cannot safely edit settings.json."
    echo "       Nothing was removed. Install node and re-run, or remove the"
    echo "       rocky SessionStart, SubagentStart, UserPromptSubmit, SessionEnd and statusLine"
    echo "       entries from $SETTINGS by hand first."
    exit 1
  else
    # Back up before editing, same policy as install.sh: never overwrite an
    # existing .bak, which is the only pre-rocky copy the user has.
    if [ ! -f "$SETTINGS.bak" ]; then
      cp "$SETTINGS" "$SETTINGS.bak"
      BACKUP_MADE=1
    fi

    # Pass paths via env vars — avoids shell injection if $HOME contains single quotes
    ROCKY_SETTINGS="$SETTINGS" ROCKY_SETTINGS_HELPER="$SETTINGS_HELPER" node -e "
      const fs = require('fs');
      const settingsPath = process.env.ROCKY_SETTINGS;
      // A settings.json with // comments is valid for Claude Code but not for
      // JSON.parse. Bail out before touching anything rather than half-
      // uninstalling: installer/install.js --uninstall handles JSONC properly.
      let settings;
      const shared = process.env.ROCKY_SETTINGS_HELPER ? require(process.env.ROCKY_SETTINGS_HELPER) : null;
      try {
        settings = shared ? shared.readSettings(settingsPath) : JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings.json must be a readable object');
      } catch (e) {
        console.error('  Cannot parse ' + settingsPath + ': ' + e.message);
        console.error('  Nothing was changed. If the file has // comments, run:');
        console.error('    npx -y github:Theralley/rocky-skill -- --uninstall');
        process.exit(3);
      }

      const path = require('path');

      // Own ONLY handlers whose command targets one of our exact script
      // basenames. A bare 'rocky' substring also matches user-authored hooks
      // that merely mention the word in a path (#593). Mirrors
      // referencesManagedScript() in installer/lib/settings.js — keep the two in sync.
      const MANAGED = new Set([
        'rocky-activate.js', 'rocky-mode-tracker.js', 'rocky-stats.js',
        'rocky-statusline.sh', 'rocky-statusline.ps1',
      ]);
      const tokenize = (command) => {
        const out = [];
        const re = /\"([^\"]*)\"|'([^']*)'|(\S+)/g;
        let m;
        while ((m = re.exec(command)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
        return out;
      };
      // win32.basename splits on both / and \\ so a settings.json written on
      // Windows still matches when this runs under bash.
      const isManaged = (command) => {
        if (typeof command !== 'string') return false;
        try {
          return tokenize(command).some(t => MANAGED.has(path.win32.basename(t)));
        } catch (e) { return false; }
      };

      let removed = 0;
      if (settings.hooks) {
        for (const event of Object.keys(settings.hooks)) {
          if (!Array.isArray(settings.hooks[event])) continue;
          let removedHere = 0;
          // Filter the inner handler list, not the entry: a matcher group
          // holding one of ours AND a foreign hook must keep the foreign one.
          settings.hooks[event] = settings.hooks[event].filter(entry => {
            if (!entry || !Array.isArray(entry.hooks)) return true;
            const before = entry.hooks.length;
            entry.hooks = entry.hooks.filter(h => !(h && isManaged(h.command)));
            const n = before - entry.hooks.length;
            removedHere += n;
            return n === 0 || entry.hooks.length > 0;
          });
          removed += removedHere;
          // Drop the event key if we emptied it (keeps settings.json tidy)
          if (removedHere > 0 && settings.hooks[event].length === 0) {
            delete settings.hooks[event];
          }
        }
        // Drop settings.hooks if it's now empty
        if (Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
        }
      }

      // Remove statusLine only when it points at our managed script. Matching
      // by basename rather than the full path also survives the slash-form
      // mismatch between a Windows-written settings.json and this env var.
      if (settings.statusLine) {
        const cmd = typeof settings.statusLine === 'string'
          ? settings.statusLine
          : (settings.statusLine.command || '');
        if (isManaged(cmd)) {
          delete settings.statusLine;
          console.log('  Removed rocky statusLine from settings.json');
        }
      }

      if (shared) shared.writeSettings(settingsPath, settings);
      else fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      console.log('  Removed ' + removed + ' rocky hook entries from settings.json');
    "
  fi
fi

# 2. Remove hook files (only now that settings.json no longer points at them)
REMOVED_FILES=0
for hook in "${HOOK_FILES[@]}"; do
  if [ -f "$HOOKS_DIR/$hook" ]; then
    if [ "$hook" = "package.json" ] && ! node -e '
      try {
        const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        process.exit(value && value.type === "commonjs" && Object.keys(value).length === 1 ? 0 : 1);
      } catch (_) { process.exit(1); }
    ' "$HOOKS_DIR/$hook" 2>/dev/null; then
      echo "  Preserved foreign manifest: $HOOKS_DIR/$hook"
      continue
    fi
    rm "$HOOKS_DIR/$hook"
    echo "  Removed: $HOOKS_DIR/$hook"
    REMOVED_FILES=$((REMOVED_FILES + 1))
  fi
done

if [ "$REMOVED_FILES" -eq 0 ]; then
  echo "  No hook files found in $HOOKS_DIR"
fi

# 3. Clean up the backup this run made. A .bak that was already there is the
# user's (or install's pre-rocky copy) and stays. So does ours when it is the
# only copy of comments the rewrite dropped, i.e. when it is not plain JSON.
if [ "$BACKUP_MADE" = 1 ] && [ -f "$SETTINGS.bak" ] \
   && ROCKY_BAK="$SETTINGS.bak" node -e "JSON.parse(require('fs').readFileSync(process.env.ROCKY_BAK, 'utf8'))" 2>/dev/null; then
  rm "$SETTINGS.bak"
  echo "  Removed: $SETTINGS.bak"
fi

# 4. Remove mode state
#
# .rocky-history.jsonl is deliberately NOT removed: it is the user's
# accumulated lifetime savings record, not rocky plumbing. Keep this list in
# sync with the uninstall block in installer/install.js.
for state in ".rocky-active" ".rocky-active.prev" ".rocky-mode-log.jsonl" ".rocky-statusline-suffix" ".rocky-nudge-shown" ".rocky-statusline-stale"; do
  if [ -f "$CLAUDE_DIR/$state" ]; then
    rm "$CLAUDE_DIR/$state"
    echo "  Removed: $CLAUDE_DIR/$state"
  fi
done

# Per-session mode files (one <session_id>.mode / .prev per window)
if [ -d "$CLAUDE_DIR/.rocky-sessions" ]; then
  rm -rf "$CLAUDE_DIR/.rocky-sessions"
  echo "  Removed: $CLAUDE_DIR/.rocky-sessions"
fi

echo ""
echo "Done! Restart Claude Code to complete the uninstall."

# Guidance for other agents
echo ""
echo "Other agents:"
echo "  npx skills remove Theralley/rocky-skill -g  # Cursor, Windsurf, Cline, Copilot, etc."
echo "  claude plugin disable rocky  # Claude Code plugin"
echo "  gemini extensions uninstall rocky  # Gemini CLI"
