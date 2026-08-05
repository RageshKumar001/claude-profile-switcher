<p align="center">
  <img src="assets/icon.png" width="112" height="112" alt="">
</p>

<h1 align="center">Claude Profile Switcher (<code>ccp</code>)</h1>

<p align="center">
  Bind each project to its own Claude Code account.
</p>

<p align="center">
  <a href="https://github.com/RageshKumar001/claude-profile-switcher/actions/workflows/test.yml"><img src="https://github.com/RageshKumar001/claude-profile-switcher/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <img src="https://img.shields.io/badge/platform-Windows-0078D4" alt="Windows">
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933" alt="Node 20+">
  <img src="https://img.shields.io/badge/dependencies-none-brightgreen" alt="No dependencies">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
</p>

---

Open a VS Code window on project A and Claude runs as your work account; open
project B and it runs as another — at the same time, in parallel, with no
logging in and out.

Set once per project, then forget. There is no "switch account" step in your day.

```powershell
ccp login work            # sign in, once
cd D:\Projects\ClientApp
ccp bind work             # this project is now on that account, permanently
```

**Your existing login is never touched.** `ccp` does not write to `~/.claude`,
and the account you are signed in as right now shows up ready to use, as
`default`. Uninstalling leaves you exactly where you started.

## Requirements

| | |
|---|---|
| **Windows** | 10 or 11. The launcher shim is a Windows executable; there is no macOS or Linux support |
| **Node.js 20+** | `node -v` |
| **Claude Code** | already installed and signed in |
| **VS Code** | for per-project binding and the status bar UI |

No npm dependencies, and no compiler to install — the shim is built on your
machine by the C# compiler Windows already ships.

## Install

One line:

```powershell
git clone https://github.com/RageshKumar001/claude-profile-switcher; cd claude-profile-switcher; npm link; ccp setup
```

Then **restart VS Code**, and install the status bar UI:

```powershell
npm run install:extension
```

<details>
<summary>What those commands actually do</summary>

- `npm link` puts `ccp` on your PATH. If your npm prefix needs admin rights and
  this fails, skip it and use `node bin/ccp.js …` in place of `ccp` everywhere
  below — nothing else changes.
- `ccp setup` compiles the 7 KB shim, then writes
  `claudeCode.claudeProcessWrapper` into your VS Code user settings, taking a
  backup first and preserving your comments. It refuses to overwrite an existing
  wrapper. `ccp setup --dry-run` shows what it would change.
- `npm run install:extension` installs the companion extension. Add `--vsix` to
  build a shareable `.vsix` instead of installing.

There is no `npm install` step because there is nothing to install.
</details>

Check it worked:

```powershell
ccp doctor
```

## Use

```powershell
ccp ls                    # your existing login already appears here, as "default"
ccp login work            # sign in; credentials land in this account's own store
ccp login personal

cd D:\Projects\ClientApp
ccp bind work             # this project now uses "work"
ccp bind default          # ...or pin a project to the account you already use

ccp current               # which account this project uses
ccp bindings              # every bound project
ccp explain               # exactly what the shim will do here, and why
```

From VS Code: click the account in the status bar, or run **Claude Profile:
Switch Account for This Project**. A binding takes effect the next time Claude
starts, so the extension offers to restart it for you.

Projects you never bind keep using your existing account, unchanged.

### Outside VS Code

The shim only covers processes VS Code launches. For a plain terminal, a
script, CI, or another editor, use the account directly:

```powershell
ccp exec work -- claude          # run anything as that account
ccp exec -- claude               # ...or as whichever account this project uses
ccp shell work                   # nested shell; the prompt shows [ccp:work]
```

`ccp shell` starts a child shell with the account set and tells you so in the
prompt — `exit` returns you to normal. It refuses to nest twice. Set `CCP_SHELL`
if you want something other than PowerShell.

For scripts, `ccp env [name]` prints the assignment rather than starting
anything:

```powershell
ccp env work | Invoke-Expression
```

Both commands set `CCP_PROFILE` in the child, so your own prompt can show it too.

## How it works

Four facts, all read out of the shipped `claude.exe` rather than assumed. Every
design decision follows from them.

**1. One environment variable relocates the credentials, and only the
credentials.**

```js
CLAUDE_SECURESTORAGE_CONFIG_DIR ?? (CLAUDE_CONFIG_DIR ?? ~/.claude)
  └─> <that dir>/.credentials.json
```

Settings, plugins, skills, project history and memory all resolve separately and
stay shared. That single variable is the whole mechanism — no overlay
directories, no junctions, nothing to keep in sync.

**2. VS Code launches Claude through a wrapper you control.**
`claudeCode.claudeProcessWrapper` is a machine-scoped setting, and the extension
spawns it with the working directory set to the workspace folder. So `ccp` sets
that wrapper **once, globally**, to a small shim — and the shim is what makes
behaviour per-project:

```
VS Code window (project A)  ─┐                    ┌─ store/work     ─┐
                             ├─> ccp-shim.exe ────┤                  ├─> claude.exe
VS Code window (project B)  ─┘   reads its cwd    └─ store/personal ─┘
```

1. Read its own working directory — the extension sets it to the workspace folder.
2. Longest-prefix match that path against the bindings index.
3. Point `CLAUDE_SECURESTORAGE_CONFIG_DIR` at the bound account's store.
4. Launch the real Claude Code, forwarding every argument and inheriting stdio.

One global setting, per-project accounts, and the native Claude Code UI fully
intact — no terminal mode, no second VS Code instance.

**The shim fails open.** It sits in front of every Claude launch in every
window, so an unhandled error there would mean Claude starts nowhere. Every path
through it is guarded: on a missing binding, an unreadable store, or any
unexpected error, it launches Claude *unmodified* and you fall back to your
normal account. The worst failure is "the binding didn't apply", never "Claude
won't start".

**3. Each window refreshes its own tokens into its own store**, because a store
directory *is* a valid credentials directory. So bound projects can never drift
out of sync — there is no capture step, no copying back, nothing to race.

**4. `~/.claude` is only ever read.** Binding a project to `default` points the
shim at `~/.claude`, which is where Claude Code would have looked anyway.

<details>
<summary>Verify that yourself</summary>

The claim worth checking before trusting any of this is that your existing
credentials are untouched. Hash them, use `ccp` for a while, hash again:

```powershell
Get-FileHash $HOME\.claude\.credentials.json -Algorithm SHA256
```

</details>

## Commands

| Command | |
|---|---|
| `ccp setup` | Build the shim, point VS Code at it (`--dry-run` to preview) |
| `ccp doctor` | Check every assumption this tool makes against your install |
| `ccp doctor --fix` | Repair what can be repaired safely |
| `ccp teardown` | Remove the VS Code wrapper setting |
| `ccp login <name>` | Add an account — browser login, straight into its own store |
| `ccp save <name>` | Copy the account already in `~/.claude` into a store |
| `ccp ls` | Accounts, token health, project counts (`--json` for scripts) |
| `ccp usage [name]` | How much quota each account has left |
| `ccp rm <name>` | Delete a profile |
| `ccp exec [name] -- <cmd>` | Run any command as an account, no VS Code involved |
| `ccp shell [name]` | Nested shell using that account; `exit` to leave |
| `ccp env [name]` | Print the environment line, for scripts and CI |
| `ccp bind <name>` | Bind the current project to an account |
| `ccp unbind` | Revert this project to the default account |
| `ccp bindings` | List every bound project |
| `ccp rule add <pattern> <name>` | Bind by git remote, e.g. `"github.com/acme/*"` |
| `ccp rule ls` / `rule rm` | List or remove rules |
| `ccp apply` | Bind this project from a rule or its `.ccp.json` |
| `ccp scan [dir]` | Apply rules across every repo under a directory |
| `ccp current` | Which account this project uses |
| `ccp explain` | What the shim will do here, and why |
| `ccp sync-mcp` | Replicate MCP server logins across all stores |
| `ccp seal [name]` | Encrypt at rest any profile not bound to a project |
| `ccp unseal <name>` | Decrypt a sealed profile |
| `ccp daemon install` | Schedule a daily job so idle profiles never expire |
| `ccp daemon run` | Run that job now (`--dry-run` to preview) |
| `ccp daemon status` | Show the scheduled task |
| `ccp daemon uninstall` | Remove the scheduled task |

Project-scoped commands accept `--cwd <path>` to act on a folder other than the
current one.

## Your existing account

The account you are already signed into shows up as **`default`**, with its real
email, plan and token expiry — no login, no setup. Unbound projects use it, and
`ccp bind default` pins a project to it explicitly.

It is deliberately a *view* of `~/.claude`, not a copy. Copying that token pair
into a store would leave two places holding one refresh token — and refresh
tokens **are** rotated on use, observed directly: a keep-alive refresh returned a
different one. Whichever copy refreshed first would leave the other holding a
spent token, which for `~/.claude` means an unwanted browser login. So `default`
is read-only: it can be listed and bound, never written to, sealed or deleted,
and `default` is a reserved name so no store can shadow it.

`ccp save <name>` does take a copy, if you want a snapshot pinned to a name that
survives signing `~/.claude` into a different account. It prints the caveat
above. `ccp login <name>` avoids it entirely by minting a separate token pair.

## Binding without binding

Binding each project by hand gets old once there are forty of them. Two ways to
declare it instead.

**By git remote.** Written once, locally, and applied to every repo you clone
afterwards:

```powershell
ccp rule add "github.com/acmecorp/*" work
ccp rule add "github.com/*/client-*"  client-a
ccp scan D:\Projects            # apply to every repo already on disk
```

The most specific pattern wins — `github.com/acme/infra` beats
`github.com/acme/*` beats `github.com/**`. `*` stops at a path separator, `**`
does not. Remotes are matched in `host/owner/repo` form, so one rule covers SSH
and HTTPS clones alike, and `.git/config` is read directly rather than shelling
out to git.

**By a file in the repo**, for teams. Commit a `.ccp.json`:

```json
{ "profile": "client-a" }
```

Everyone who opens that repo uses their own profile of that name. The file holds
**a name and nothing else** — no tokens, no email — so it is safe to commit.

Because it arrives inside a repo you cloned, it is never obeyed silently: `ccp`
asks the first time and remembers your answer. Rules, being yours already, apply
without asking. VS Code asks in its own UI when you open the folder.

One thing to weigh: a profile name in a public repo is public. Name profiles
neutrally, or skip the file and use a local rule.

Both are resolved by `ccp` and written into the same bindings the shim reads —
the shim itself is never taught about rules or JSON, so it stays a lookup that
cannot fail.

## Quota

Holding several accounts turns "which one has room left?" into a daily
question. `ccp usage` answers it for all of them at once:

```
  ACCOUNT     SESSION  WEEK     OPUS  RESETS
  default      62% 5h   22% 7d  -     resets in 2h 48m
  work        100% 5h   61% 7d  -     resets in 1h 8m

  work out of quota -- ccp bind default has room
```

The VS Code status bar shows the same figure for the account this project uses
(`work  62%`), and turns amber when it hits 100%. The account picker shows every
account's usage, so you can choose one with headroom rather than discovering the
limit mid-task.

This costs nothing. Claude Code reads quota from a dedicated endpoint rather
than from inference response headers, so `ccp` asks the same way — no tokens
spent to find out how many tokens you have left. Figures are cached, and
`--max-age <seconds>` will serve from that cache instead of asking again.

One limit: if the default account's access token has lapsed, its quota reads as
unavailable rather than being refreshed. Refreshing rotates the token, and `ccp`
does not do that to `~/.claude`. Using Claude normally clears it.

## What is shared, what is separate

Only credentials are per-account. Everything else stays exactly where it is,
common to every account, and **nothing is deleted or reset when you switch**:

| Shared across all accounts | Separate per account |
|---|---|
| Session transcripts | The login itself (`claudeAiOauth`) |
| Memory — `~/.claude/projects/<slug>/memory/` | `organizationUuid` |
| `CLAUDE.md` files in your repos | MCP server logins — *see below* |
| `settings.json`, skills, plugins, hooks | |
| Project trust, `allowedTools`, MCP config | |

This is the decisive advantage over relocating `CLAUDE_CONFIG_DIR`, which would
split your memory and history per account.

## Keeping accounts alive

Access tokens last about 8 hours, and Claude Code renews them itself using the
refresh token — into whichever store it is bound to, with no browser and no
prompt. An account you use regularly never needs signing in again.

An account you *stop* using is the problem. Claude Code records no expiry for the
refresh token — the field is absent from the credentials it writes — so there is
no deadline to read off disk, only the certainty that it does not last forever.
The keep-alive job therefore refreshes any profile with no known deadline, which
both keeps it alive and is the only way to find out it still works.

```powershell
ccp daemon install        # daily scheduled task
ccp daemon run --dry-run  # see what it would do
```

## Encryption at rest

```powershell
ccp seal                  # encrypt every profile not bound to a project (DPAPI, CurrentUser)
ccp unseal <name>
```

Bound profiles stay in plaintext — the shim reads the file directly at launch and
deliberately cannot decrypt. `ccp bind` unseals automatically.

Be clear on what this buys: DPAPI unseals automatically for anything running as
you, so it is not protection against malware in your own session. It means
copying the folder off the machine yields nothing, and only accounts actually in
use sit in plaintext.

## Things you should know

**Claude Code's `/status` can name the wrong account.** Only credentials are
per-project; the identity block Claude displays lives in the shared
`~/.claude.json`, which no store redirects. Two consequences: a bound project
shows the default account rather than its own, and `ccp login` — which spawns
Claude's own browser login — overwrites that block with the account being added,
so it can be wrong even in unbound projects. Claude Code only re-fetches identity
when the block is *incomplete*, so a complete-but-wrong one is never
self-corrected.

Authentication is unaffected throughout: you really are signed in as the bound
account. `ccp ls` and `ccp doctor` detect the mismatch by comparing that block's
organisation against the live credentials, and hide the email rather than name
the wrong account. The extension's status bar is the reliable indicator.

**MCP logins are per-store**, because they live inside the same credentials file.
`ccp` treats them as account-independent and replicates them across stores,
automatically after login and in the daily job, or on demand with `ccp sync-mcp`.

**This is built on undocumented internals.** Every mechanism was read out of the
shipped `claude.exe`, not from a public API. A Claude Code update can break it.
`ccp doctor` exists to say precisely what changed rather than let the tool
corrupt anything.

**There is a remote kill switch.** `tengu_windows_credman` is a server-controlled
flag. If Anthropic turns it on, credentials move into Windows Credential Manager
and file-based binding stops working. `ccp doctor` reports the flag's state.

**On multiple accounts:** using accounts you legitimately hold for their intended
contexts — a work seat for work, a client's org seat for that client — is what
this is for. Spreading one person's workload across several accounts to get more
total capacity than any one plan allows is a different thing, and Anthropic's
terms treat it differently. Worth checking your plan before relying on it.

## Troubleshooting

**Run `ccp doctor` first, for anything.** It checks every assumption this tool
makes against your Claude Code install and names what has drifted. Because all of
this rests on undocumented internals, a Claude Code update can break everyone at
once — `doctor` output is what to compare when that happens.

`ccp doctor --fix` repairs the structural things: rebuilding the shim, restoring
the VS Code wrapper setting, regenerating the bindings index, dropping bindings
whose profile no longer exists, and unsealing a sealed profile that a project is
bound to. Every repair is safe to run twice.

It deliberately will **not** touch anything else. It never writes to `~/.claude`,
never refreshes or replaces a token, and never overwrites a
`claudeProcessWrapper` that belongs to some other tool. Anything needing a login
or a token refresh is reported and left for you — `ccp login` and
`ccp daemon run` are the commands for those.

| Symptom | |
|---|---|
| `ccp` is not recognised | `npm link` didn't take. Use `node bin/ccp.js …`, or add npm's global bin to PATH |
| The binding isn't applying | Restart VS Code — `ccp setup` writes a setting the extension reads at startup. Then `ccp explain` in that folder |
| `/status` names the wrong account | Expected; see above. Authentication is still correct — trust the status bar |
| `ccp setup` refused to configure VS Code | You already have a `claudeProcessWrapper` set. Remove it, or chain it from the shim |
| An account says re-login needed | Its refresh token died. `ccp login <name>` again; `ccp daemon install` prevents it recurring |
| MCP servers ask you to sign in again | `ccp sync-mcp` |

## Uninstall

```powershell
ccp teardown              # remove the VS Code wrapper setting
ccp daemon uninstall      # remove the scheduled task, if you installed it
npm unlink -g claude-profile-switcher
```

Delete `~/.claude-profiles` to remove the stored accounts. `~/.claude` was never
modified, so your original login is exactly as you left it.

## Sharing it with your team

> **Never share a credential store.** `~/.claude-profiles/store/` contains live
> OAuth tokens — copying one to a colleague hands them your account. Share this
> repository; everyone runs `ccp login` for accounts they hold themselves. The
> `.gitignore` blocks stores, `bindings.json` and `install.json` from ever being
> committed, but the rule matters more than the safeguard.

Each teammate runs the same one-line install above. If you would rather not stand
up a repo, `npm pack` produces a single tarball they can extract and run the same
commands in. To hand out the VS Code extension on its own,
`npm run install:extension -- --vsix` builds a `.vsix` that installs via
**Extensions: Install from VSIX…**.

**On accounts:** this binds projects to accounts, it does not create or share
them. Each person needs their own legitimately held accounts — a work seat, a
client's org seat. It cannot be used to let several people share one seat.

## Development

```powershell
npm test                  # 23 unit tests, no dependencies
node scripts/build-shim.mjs
```

| Path | Purpose |
|---|---|
| `bin/ccp.js` | CLI entry point |
| `src/paths.js` | Mirrors Claude Code's config/credential path resolution exactly |
| `src/bindings.js` | Project → account mapping, and the flat index the shim reads |
| `src/credentials.js` | Account vs shared key split, atomic writes |
| `src/default-profile.js` | The read-only view of `~/.claude` |
| `src/oauth.js` | Token refresh, matching the client's own request shape |
| `shim/ccp-shim.cs` | The wrapper VS Code launches |
| `vscode-extension/` | Status bar and quick pick |

The shim reads `bindings.tsv`, not JSON, on purpose: it sits in front of every
Claude launch, so it must degrade to "no binding" rather than throw.

Contributions welcome — especially `ccp doctor` checks for anything that changes
in a future Claude Code release.

## License

MIT. See [LICENSE](LICENSE).
