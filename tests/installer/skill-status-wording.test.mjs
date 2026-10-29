// `/rocky status` on a host with no mode hook (Copilot CLI, Cursor, ...) must
// answer from the conversation with an honest marker, never a bare `unknown`
// that reads as a broken install (#1185).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");

for (const file of [
  "skills/rocky/SKILL.md",
  "skills/ultrarocky/SKILL.md",
  "skills/megarocky/SKILL.md",
  "skills/rocky-help/SKILL.md",
  // Ships inside dist/rocky.skill next to the SKILL.md.
  "skills/rocky/README.md",
]) {
  test(`${file}: hook-less status is marked, not unknown`, () => {
    const body = read(file).replace(/\s+/g, " ");
    assert.ok(body.includes("(not tracked by this host)"), "names the no-hook marker");
    assert.doesNotMatch(body, /Rocky mode: unknown|report `unknown`|or `unknown`/);
  });
}
