// ccp-shim -- per-project Claude Code account binding.
//
// The VS Code extension setting `claudeCode.claudeProcessWrapper` is machine
// scoped, so it can only be set once, globally. This shim is what makes the
// behaviour per-project: it is launched with cwd set to the workspace folder,
// looks that folder up in the bindings index, points
// CLAUDE_SECURESTORAGE_CONFIG_DIR at the bound account's credential store, and
// hands off to the real Claude Code executable.
//
// Invocation shape (from the extension's resolveClaudeBinary):
//     ccp-shim.exe <realClaudeExecutable> [args...]
// The real executable arrives as the first argument, so the shim never has to
// find Claude itself.
//
// FAIL OPEN. This sits in front of every Claude launch in every window. Any
// failure here must still start Claude on the default account rather than stop
// it from starting at all.
//
// Built by scripts/build-shim.mjs using the csc.exe shipped with Windows.

using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class CcpShim
{
    private static string _logPath;

    private static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            Console.Error.WriteLine("ccp-shim: no target executable supplied");
            return 1;
        }

        string target = args[0];
        string remainder = TailOfCommandLine(Environment.CommandLine, 2);
        string storeDir = null;
        string profile = null;
        string root = null;
        string cwd = null;

        try
        {
            root = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".claude-profiles");
            _logPath = Path.Combine(root, "logs", "shim.log");

            cwd = Normalize(Directory.GetCurrentDirectory());
            Lookup(Path.Combine(root, "bindings.tsv"), cwd, out storeDir, out profile);
        }
        catch (Exception ex)
        {
            // Resolution failed; carry on unbound rather than blocking startup.
            Log("resolve failed: " + ex.Message);
            storeDir = null;
        }

        var psi = new ProcessStartInfo(target);
        psi.Arguments = remainder;
        // No redirection: the child inherits our stdin/stdout/stderr handles
        // directly. The SDK talks a stream protocol over those pipes, so they
        // must pass through untouched.
        psi.UseShellExecute = false;
        psi.CreateNoWindow = false;

        if (storeDir != null)
        {
            try
            {
                if (Directory.Exists(storeDir))
                {
                    // Overwrite, never set-if-absent: the SDK already places
                    // this variable in the child environment, sometimes as "",
                    // which Claude Code reads as "use the default store".
                    psi.EnvironmentVariables["CLAUDE_SECURESTORAGE_CONFIG_DIR"] = storeDir;
                    // Never for "default": that store is ~/.claude, and this
                    // tool promises not to write there. The marker only exists
                    // so the keep-alive job can tell idle stores from active
                    // ones, and ~/.claude is not a store it ever refreshes.
                    if (!string.Equals(profile, "default", StringComparison.OrdinalIgnoreCase))
                    {
                        MarkUsed(storeDir);
                    }
                    LogVerbose("bound " + profile + " -> " + storeDir);
                }
                else
                {
                    Log("bound store missing, falling back to default: " + storeDir);
                }
            }
            catch (Exception ex)
            {
                Log("bind failed, falling back to default: " + ex.Message);
            }
        }

        try
        {
            using (Process child = Process.Start(psi))
            {
                // A binding only ever applies to a process at the moment it is
                // launched, so the binding on disk is a statement about the next
                // launch -- not about anything already running. Recording what
                // this process actually got is the only way `ccp sessions` can
                // tell you that a live conversation is on a different account
                // than the one you just switched to.
                string record = RecordLaunch(root, child.Id, profile, storeDir, cwd);
                try
                {
                    child.WaitForExit();
                    return child.ExitCode;
                }
                finally
                {
                    Forget(record);
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("ccp-shim: failed to launch " + target + ": " + ex.Message);
            Log("launch failed: " + ex.Message);
            return 1;
        }
    }

    /// <summary>
    /// Note that a Claude process is running on a given account.
    ///
    /// Best effort, like every other piece of bookkeeping here: a failure to
    /// record must never stop Claude starting. Returns the file written, or
    /// null if nothing was.
    /// </summary>
    private static string RecordLaunch(
        string root, int pid, string profile, string storeDir, string cwd)
    {
        if (root == null) return null;
        try
        {
            string dir = Path.Combine(root, "launches");
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, pid + ".tsv");
            // An unbound launch is recorded too. "running on default because no
            // binding matched" is exactly the state worth being able to see.
            File.WriteAllText(
                file,
                string.Join("\t", new string[] {
                    DateTime.UtcNow.ToString("o"),
                    profile ?? "default",
                    storeDir ?? string.Empty,
                    cwd ?? string.Empty,
                }) + Environment.NewLine,
                new UTF8Encoding(false));
            return file;
        }
        catch
        {
            return null;
        }
    }

    private static void Forget(string record)
    {
        try
        {
            if (record != null) File.Delete(record);
        }
        catch
        {
            // A stale record is harmless: readers drop any whose pid is gone.
        }
    }

    /// <summary>
    /// Find the bound store for a directory.
    ///
    /// The index is a tab-separated file, one binding per line, pre-sorted
    /// longest-prefix-first by ccp -- so the first match wins and there is no
    /// parser to go wrong. Deliberately not JSON: this code path must not be
    /// able to throw on malformed input.
    /// </summary>
    private static void Lookup(string indexPath, string cwd, out string storeDir, out string profile)
    {
        storeDir = null;
        profile = null;
        if (!File.Exists(indexPath)) return;

        foreach (string line in File.ReadAllLines(indexPath))
        {
            if (line.Length == 0) continue;
            string[] parts = line.Split('\t');
            if (parts.Length < 2) continue;

            string prefix = parts[0];
            if (prefix.Length == 0) continue;
            if (!IsUnder(cwd, prefix)) continue;

            storeDir = parts[1];
            profile = parts.Length > 2 ? parts[2] : "(unnamed)";
            return;
        }
    }

    private static bool IsUnder(string child, string parent)
    {
        if (child == parent) return true;
        string basePath = parent.EndsWith("\\") ? parent : parent + "\\";
        return child.StartsWith(basePath, StringComparison.Ordinal);
    }

    /// <summary>Must match normalizeProjectPath() in src/bindings.js.</summary>
    private static string Normalize(string p)
    {
        string out_ = Path.GetFullPath(p).Replace('/', '\\').ToLowerInvariant();
        if (out_.Length > 3 && out_.EndsWith("\\")) out_ = out_.Substring(0, out_.Length - 1);
        return out_;
    }

    /// <summary>
    /// Everything after the first `skip` tokens of the raw command line.
    ///
    /// Taken verbatim rather than re-quoting args[], so the child receives
    /// exactly the quoting the caller used.
    /// </summary>
    private static string TailOfCommandLine(string commandLine, int skip)
    {
        int i = 0;
        for (int n = 0; n < skip; n++) i = SkipToken(commandLine, i);
        while (i < commandLine.Length && char.IsWhiteSpace(commandLine[i])) i++;
        return i >= commandLine.Length ? string.Empty : commandLine.Substring(i);
    }

    private static int SkipToken(string s, int i)
    {
        while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
        if (i >= s.Length) return i;

        if (s[i] == '"')
        {
            i++;
            while (i < s.Length && s[i] != '"') i++;
            if (i < s.Length) i++;
        }
        else
        {
            while (i < s.Length && !char.IsWhiteSpace(s[i])) i++;
        }
        return i;
    }

    /// <summary>
    /// Record that this store was launched, so the keep-alive job can tell
    /// active profiles from genuinely idle ones. Best effort only.
    /// </summary>
    private static void MarkUsed(string storeDir)
    {
        try
        {
            File.WriteAllText(
                Path.Combine(storeDir, ".last-used"),
                DateTime.UtcNow.ToString("o"),
                new UTF8Encoding(false));
        }
        catch
        {
            // Never let bookkeeping stop a launch.
        }
    }

    private static void LogVerbose(string message)
    {
        if (Environment.GetEnvironmentVariable("CCP_SHIM_DEBUG") == "1") Log(message);
    }

    private static void Log(string message)
    {
        try
        {
            if (_logPath == null) return;
            Directory.CreateDirectory(Path.GetDirectoryName(_logPath));
            File.AppendAllText(
                _logPath,
                DateTime.UtcNow.ToString("o") + "  " + message + Environment.NewLine,
                new UTF8Encoding(false));
        }
        catch
        {
            // Logging must never be the reason Claude fails to start.
        }
    }
}
