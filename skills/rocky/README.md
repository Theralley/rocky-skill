# rocky

Talk like Rocky the Eridian. Same brain, fewer tokens.

## What it does

Makes the model answer first and cut the ceremony: no greeting, hedging,
filler, recap, or closer. Articles drop when the sentence still reads in one
pass. Code, commands, paths, numbers, and exact error strings never change.
Result depends on model and workload. Not measured for Rocky yet. Upstream caveman publishes its own numbers, but they do not transfer: Rocky's markers and catchphrases add words. Mode persists until changed or stopped.

Rocky is one of three sibling skills:

| Skill | Command | What change |
|-------|---------|-------------|
| `rocky` | `/rocky` | The voice. Default. Answer first, filler gone, every fact kept, a few Rocky markers. `/rocky lite` keeps the rules and drops the flavor. |
| `ultrarocky` | `/ultrarocky` | Grammar stripped. Fragments, one word when one word is enough, each fact once. |
| `megarocky` | `/megarocky` | Classical Chinese (文言文). Far fewer characters, technical terms verbatim. |

`/rocky ultra` and `/rocky wenyan` still work as aliases.

Auto-clarity: every skill drops to normal prose for security warnings,
irreversible-action confirmations, step sequences a fragment could scramble,
and a user who repeats a question. Resumes after the clear part.

## How to invoke

```
/rocky              # the voice (default)
/rocky lite         # same rules, no Rocky flavor
/rocky status       # show current mode without changing it
/ultrarocky         # grammar stripped
/megarocky          # classical Chinese
stop rocky          # back to normal prose
```

Claude Code and the standalone OpenCode plugin read stored mode state. Other
hosts answer from the conversation and mark it `(not tracked by this host)`.

Want Claude Code sessions to start with normal prose? Set
`{"defaultMode":"manual"}` in `.rocky.json` for one project or
`~/.config/rocky/config.json` for your user. You can also set
`ROCKY_DEFAULT_MODE=manual`. Then `/rocky` activates the voice and
`/ultrarocky` selects ultrarocky. Stop persists across compaction and resume; a
fresh session starts off again. This startup policy is Claude Code-only:
OpenCode keeps its rocky default because the installer also supplies static
activation rules.

## Example output

Question: "Why does my React component re-render?"

Normal prose:
> Your component re-renders because you create a new object reference each render. Wrapping it in `useMemo` will fix the issue.

rocky:
> Component re-render. New object ref each render. Wrap the prop in `useMemo`.

ultrarocky:
> Inline object prop, new ref, re-render. `useMemo`.

megarocky:
> 每繪新生對象參照，故重繪；以 `useMemo` 包之則免。

## See also

- [`SKILL.md`](./SKILL.md): full LLM-facing instructions
- [`../ultrarocky/`](../ultrarocky/) and [`../megarocky/`](../megarocky/): the sibling skills
- [Rocky README](../../README.md): repo overview and install
