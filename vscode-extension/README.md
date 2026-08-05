<p align="center">
  <img src="icon.png" width="96" height="96" alt="">
</p>

<h1 align="center">Claude Profile Switcher</h1>

<p align="center">
  Bind each project to its own Claude Code account, and switch from the status bar.
</p>

---

Open one VS Code window on your work project and Claude runs as your work
account. Open another on a client project and it runs as that client's account —
at the same time, in parallel, with no signing in and out.

## What you get

**A status bar item** showing which account this project uses, and how much
quota it has left. Click it to change.

```
                              ⟨account⟩ work  62%    ← click to switch
```

It turns amber when that account hits its limit, so you find out before your
next prompt does.

**A quick pick** listing your accounts with their email, plan, token health and
current usage, so you can pick one with headroom rather than discovering the
limit mid-task. The account you are *already* signed into is in that list as
**`default`** — nothing to set up, and it is read-only, so picking it never
rewrites your existing login.

**Commands**, from the palette or by right-clicking a folder in the explorer:

| Command | What it does |
|---|---|
| `Claude Profile: Switch Account for This Project` | Pick the account for this folder |
| `Claude Profile: Add Account` | Sign in to a new account |
| `Claude Profile: Use Default Account for This Project` | Remove the binding |
| `Claude Profile: Show Usage` | Quota for every account, in the output panel |
| `Claude Profile: Refresh Status` | Re-read the current binding |

Multi-root workspaces are handled per folder — the status bar follows whichever
folder your active editor is in.

## Requirements

This extension is the UI for the `ccp` CLI, which does the real work. Install
and set it up first — one line, no dependencies:

```powershell
git clone https://github.com/RageshKumar001/claude-profile-switcher; cd claude-profile-switcher; npm link; ccp setup
```

That builds the launcher shim and points Claude Code's
`claudeCode.claudeProcessWrapper` setting at it. The extension finds the CLI
through the manifest that `setup` writes to `~/.claude-profiles/install.json`.

Windows only, and Node.js 20+. Full documentation is in the
[project README](https://github.com/RageshKumar001/claude-profile-switcher).

## Two behaviours worth knowing

**Claude's own `/status` shows the wrong account in a project bound to anything
other than `default`.** Only credentials are bound per project; the identity
block Claude displays lives in the shared config. You really are authenticated
as the bound account — just that one readout lags. The status bar is the
reliable indicator, which is much of why it exists.

**A change applies on Claude's next launch**, because the account is resolved
when the process starts. After switching, the extension offers **Restart
Claude**; if that doesn't take, reloading the window always works.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `ccp.showStatusBar` | `true` | Show the bound account in the status bar |
| `ccp.cliPath` | `""` | Override the CLI location; empty reads `install.json` |

## Troubleshooting

Run `ccp doctor`. It checks every assumption the tool makes against your Claude
Code install and names anything that has drifted — this is all built on
undocumented internals, so a Claude Code update can break it, and `doctor` is
how you find out what changed.
