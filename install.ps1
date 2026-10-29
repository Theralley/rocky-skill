# rocky — installer shim (Windows / PowerShell).
#
# Thin wrapper around installer/install.js (the unified Node installer). Every flag
# you'd pass to installer/install.js can be passed here; we just forward them.
#
# One-line install:
#   irm https://raw.githubusercontent.com/Theralley/rocky-skill/v1.1.0/install.ps1 | iex
#
# Local clone:
#   pwsh install.ps1 [flags]
#
# Why a Node installer? install.sh + install.ps1 used to be parallel sources of
# truth and constantly drifted (issue #249 was a `node -e "..."` quoting bug
# that silently dropped the JSON merge step on every Windows install). One
# Node script works everywhere without quoting bugs.
#
# Why no top-level param() and everything inside a function? `irm | iex`
# executes this file as a string: script-path variables ($PSCommandPath,
# $MyInvocation.MyCommand.Path) are $null and a top-level param block cannot
# receive arguments through a pipe anyway (issue #565). Wrapping the logic in
# a function and forwarding $args keeps one script working for both the pipe
# path (no args, no script path) and the local-clone path.

function Install-Rocky {
  param(
    [string[]]$InstallerArgs = @()
  )

  $ErrorActionPreference = "Stop"
  $Repo = "Theralley/rocky-skill"
  $PinnedRef = if ($env:ROCKY_REF) { $env:ROCKY_REF } else { "v1.1.0" }

  # Require Node ≥18.
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Error @"
rocky: Node.js (>=18) required. Install:
  - winget install OpenJS.NodeJS.LTS
  - or download from https://nodejs.org
"@
    $global:LASTEXITCODE = 1; return
  }

  $nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
  if ($nodeMajor -lt 18) {
    Write-Error "rocky: Node $nodeMajor too old. Need Node >=18. Upgrade: https://nodejs.org"
    $global:LASTEXITCODE = 1; return
  }

  # If we're inside the repo clone, run the local installer directly.
  # $PSCommandPath is $null when piped to iex (#565) — the old unguarded
  # Split-Path on it was the "Cannot bind argument to parameter 'Path'
  # because it is null" crash.
  $local = $null
  if ($PSCommandPath) {
    $here = Split-Path -Parent $PSCommandPath
    $local = Join-Path $here "installer/install.js"
    if (-not (Test-Path $local)) { $local = $null }
  }

  if ($local) {
    & node $local @InstallerArgs
  } else {
    # Curl-pipe path: delegate to npx.
    $npx = Get-Command npx -ErrorAction SilentlyContinue
    if (-not $npx) {
      Write-Error "rocky: npx required (ships with Node >=18). Reinstall Node.js."
      $global:LASTEXITCODE = 1; return
    }

    # Do NOT pass `--` here — npm 7+ npx already forwards trailing args to the
    # package, and a literal `--` was tripping installer/install.js's parseArgs as an
    # unknown flag.
    # npm 12 disables git package fetches by default (EALLOWGIT). Allow only the
    # root package requested here; older npm versions do not understand this
    # config flag.
    # 2>$null mirrors install.sh's `2>/dev/null`: npm writes its "does not support
    # Node.js" notice to stderr, and a contaminated value would floor the major to 0.
    $npxVersion = [string](& npx --version 2>$null)
    $npxMajor = 0
    if ($npxVersion -match '^(\d+)') {
      $npxMajor = [int]$Matches[1]
    }

    if ($npxMajor -ge 12) {
      & npx --allow-git=root -y "github:$Repo#$PinnedRef" @InstallerArgs
    } else {
      & npx -y "github:$Repo#$PinnedRef" @InstallerArgs
    }
  }
}

# $args is the automatic variable: populated when run as a file
# (`pwsh install.ps1 --force`), empty under `irm | iex`.
Install-Rocky -InstallerArgs $args
# Under `irm | iex` this runs in the user's own session, where `exit` would
# close their window over the output above; only a script file exits.
if ($PSCommandPath) { exit $LASTEXITCODE }
