---
name: rockycrew
description: >
  When to delegate to `rockycrew-investigator` (locate code), `rockycrew-builder`
  (1-2 file edit) or `rockycrew-reviewer` (diff review) instead of working inline
  or using `Explore`. Their output is compressed, so main context lasts longer.
---

Rockycrew = three subagent presets that answer in ultrarocky voice (tool runs: one status line in, one out; nothing between routine calls). Same job as Anthropic defaults (`Explore`, edit-style agents, reviewer); difference is the tool-result they return is compressed, so main context shrinks per delegation.

## When to use rockycrew vs alternatives

| Task | Use |
|---|---|
| "Where is X defined / what calls Y / list uses of Z" | `rockycrew-investigator` |
| Same but you also want suggestions/architecture commentary | `Explore` (vanilla) |
| Surgical edit, ≤2 files, scope obvious | `rockycrew-builder` |
| New feature / 3+ files / cross-cutting refactor | Main thread, or `feature-dev:code-architect` if installed |
| Review diff, branch, or file for bugs | `rockycrew-reviewer` |
| Deep code review with rationale + alternatives | `Code Reviewer` (vanilla) if installed, else main thread |
| One-line answer you already know | Main thread, no subagent |

Rule of thumb: **if you'd want the subagent's output in 1/3 the tokens, pick rockycrew. If you'd want prose, pick vanilla.**

## Why this exists (the real win)

Subagent tool results get injected into main context verbatim. A vanilla `Explore` that returns 2k tokens of prose costs 2k tokens of main-context budget every time. The same finding from `rockycrew-investigator` comes back as a compressed `path:line` table instead. Across 20 delegations in one session that's the difference between context exhaustion and finishing the task.

## Output contracts

What main thread can rely on per agent:

**`rockycrew-investigator`**
```
<Header>:
- path:line — `symbol` — short note
totals: <counts>.
```
Or `No match.` Always file-path-first, line-number-attached, backticked symbols. Safe to grep with `path:\d+`.

**`rockycrew-builder`**
```
<path:line-range> — <change ≤10 words>.
verified: <re-read OK | mismatch @ path:line>.
```
Or one of: `too-big.` / `needs-confirm.` / `ambiguous.` / `regressed.` (terminal first token).

**`rockycrew-reviewer`**
```
path:line: <emoji> <severity>: <problem>. <fix>.
totals: N🔴 N🟡 N🔵 N❓
```
Or `No issues.` Findings sorted file → line ascending.

## Chaining patterns

**Locate → fix → verify** (most common):
1. `rockycrew-investigator` returns site list.
2. Main thread picks 1-2 sites, hands paths to `rockycrew-builder`.
3. `rockycrew-reviewer` audits the diff.

**Parallel scout** (when investigation is broad):
Spawn 2-3 `rockycrew-investigator` calls in one message (different angles: defs vs callers vs tests). Aggregate in main thread.

**Single-shot edit** (when site is already known):
Skip investigator. Hand exact path:line to `rockycrew-builder` directly.

## What NOT to do

- Don't use `rockycrew-builder` when you don't already know the file. Spawn investigator first or main thread will eat tokens passing context.
- Don't chain `rockycrew-investigator → rockycrew-builder` for a 5-file refactor. Builder will return `too-big.` and you'll have wasted a turn.
- Don't ask `rockycrew-reviewer` for "general feedback" — it returns findings only, no architecture opinions. Use `Code Reviewer` for that when installed.
- Don't expect prose. Rockycrew output is structured, sometimes terse to the point of cryptic. If a human will read it directly, paraphrase.

## Auto-clarity (inherited)

Subagents drop rocky → normal English for security warnings, irreversible-action confirmations, and any output where fragment ambiguity could be misread. Resume rocky after.
