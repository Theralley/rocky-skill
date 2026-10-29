"""Export an upstream caveman commit as a rocky-named tree.

Usage: python3 scripts/upstream-sync/transform.py UPSTREAM_REPO COMMIT OUT_DIR SCOPE_FILE

SCOPE_FILE lists upstream path globs (one per line, '#' comments). Paths and
text content are renamed the way the original Rocky fork renamed them.
"""
import fnmatch
import os
import subprocess
import sys

repo, commit, out, scope_file = sys.argv[1:5]
globs = [l.strip() for l in open(scope_file, encoding="utf-8") if l.strip() and not l.startswith("#")]
include = [g for g in globs if not g.startswith("!")]
exclude = [g[1:] for g in globs if g.startswith("!")]

files = subprocess.run(["git", "-C", repo, "ls-tree", "-r", "--name-only", commit],
                       capture_output=True, text=True, check=True).stdout.split("\n")

TEXT_RULES = [
    # repo identity first, before the bare word rules touch it
    ("github:JuliusBrussee/caveman", "github:Theralley/rocky-skill"),
    ("JuliusBrussee/caveman", "Theralley/rocky-skill"),
    ("Respond terse like smart caveman", "Respond terse like Rocky the Eridian"),
    ("smart caveman", "Rocky the Eridian"),
    ("ultracave", "ultrarocky"), ("Ultracave", "Ultrarocky"), ("ULTRACAVE", "ULTRAROCKY"),
    ("megacave", "megarocky"), ("Megacave", "Megarocky"), ("MEGACAVE", "MEGAROCKY"),
    ("cavecrew", "rockycrew"), ("Cavecrew", "Rockycrew"), ("CAVECREW", "ROCKYCREW"),
    ("cavemen", "rockies"),
    ("caveman", "rocky"), ("Caveman", "Rocky"), ("CAVEMAN", "ROCKY"),
]
PATH_RULES = [("ultracave", "ultrarocky"), ("megacave", "megarocky"),
              ("cavecrew", "rockycrew"), ("caveman", "rocky")]
BINARY = (".png", ".jpg", ".gif", ".ico", ".skill", ".zip", ".woff", ".woff2", ".wasm")


def wanted(path):
    if not path:
        return False
    if any(fnmatch.fnmatch(path, g) for g in exclude):
        return False
    return any(fnmatch.fnmatch(path, g) for g in include)


def rename_path(path):
    for a, b in PATH_RULES:
        path = path.replace(a, b)
    return path


def rename_text(text):
    for a, b in TEXT_RULES:
        text = text.replace(a, b)
    return text


count = 0
for path in filter(wanted, files):
    blob = subprocess.run(["git", "-C", repo, "show", f"{commit}:{path}"],
                          capture_output=True, check=True).stdout
    dest = os.path.join(out, rename_path(path))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    # Legal texts travel verbatim: a renamed NOTICE would misattribute caveman's copyright.
    if not path.endswith(BINARY) and not os.path.basename(path).startswith(("LICENSE", "NOTICE")):
        try:
            blob = rename_text(blob.decode("utf-8")).encode("utf-8")
        except UnicodeDecodeError:
            pass
    with open(dest, "wb") as fh:
        fh.write(blob)
    mode = subprocess.run(["git", "-C", repo, "ls-tree", commit, "--", path],
                          capture_output=True, text=True).stdout.split(" ")[0]
    if mode == "100755":
        os.chmod(dest, 0o755)
    count += 1
print(f"{count} files -> {out}", file=sys.stderr)
