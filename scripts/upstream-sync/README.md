# Syncing from upstream caveman

Rocky is a renamed fork of [caveman](https://github.com/JuliusBrussee/caveman),
not a GitHub fork, so `git merge upstream` does not work. Instead, rename two
upstream snapshots the same way and let git replay the difference onto Rocky as
a 3-way merge. Rocky's own edits (voice, README, docs) survive; only lines both
sides changed conflict.

**Last synced upstream commit:** `9b68f7e` (2026-10-25, after caveman v4.0.1).
Use it as `BASE` next time.

```sh
UP=$(mktemp -d)/caveman && git clone -q https://github.com/JuliusBrussee/caveman.git "$UP"
BASE=9b68f7e; HEAD_REF=main; OUT=$(mktemp -d)
python3 scripts/upstream-sync/transform.py "$UP" "$BASE" "$OUT/base" scripts/upstream-sync/scope.txt
python3 scripts/upstream-sync/transform.py "$UP" "$HEAD_REF" "$OUT/head" scripts/upstream-sync/scope.txt

# Snapshot both trees as commits, then cherry-pick head onto a sync branch.
tree() { GIT_INDEX_FILE="$OUT/idx" git --work-tree="$OUT/$1" add -A . >/dev/null && GIT_INDEX_FILE="$OUT/idx" git write-tree; rm -f "$OUT/idx"; }
B=$(git commit-tree "$(tree base)" -m "caveman $BASE, renamed")
H=$(git commit-tree "$(tree head)" -p "$B" -m "caveman $HEAD_REF, renamed")
git switch -c sync-caveman-$(date +%F)
git -c merge.renameLimit=5000 cherry-pick --no-commit "$H"
```

Then, before committing:

1. Resolve conflicts. Rocky's voice files win on wording; upstream wins on code.
2. Check `scope.txt` against new upstream directories. Anything that needs the
   caveman CLI, engine, proxy or cloud stays out, and so do its tests.
3. Grep for leaks: `@rocky-ai`, `rocky.sh`, `rocky setup`, `rocky enable`,
   `JuliusBrussee\/rocky` (escaped regex forms escape the rename) and new
   version pins (`PINNED_REF`, shims, manifests).
4. Keep `src/rules/rocky-activate.md` byte-equal to `RULE_BODY` in
   `src/tools/rocky-init.js`, regenerate `src/hooks/checksums.sha256`, sync the
   `plugins/rocky/` mirrors and rebuild `dist/rocky.skill`.
5. Run `npm test`, `node --test --test-force-exit tests/*.js`,
   `python3 -m unittest discover -s tests` and `python3 tests/verify_repo.py`
   (Python 3.11+).
6. Update the last-synced commit above.
