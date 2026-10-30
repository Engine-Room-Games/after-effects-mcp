# When something goes wrong

Start here: **ask your assistant to check the After Effects setup.** It reports
which part is broken and what to do about it, in plain words. Most of the time
that is all you need.

Back to the [README](../README.md).

## Messages you might see

| Symptom | Cause and fix |
|---|---|
| "Cannot reach the After Effects panel" | After Effects isn't running, or the panel isn't installed. Ask it to set up After Effects; if AE was closed, just open it afterwards. |
| "The panel did not answer within …s" | Not the same thing. After Effects is busy — usually a long script, or a dialog waiting for a click behind another window. Close any dialog, wait a minute and check again before restarting anything; the work normally finishes on its own, so don't ask for it again. |
| "The After Effects panel is out of date" | The tools were updated but the panel wasn't. Ask it to update the panel, then restart AE. |
| "…refused this call: the bridge token did not match" | Not a lost connection — the panel answered and turned the request away, and nothing in your project changed. Usually an old panel from a previous After Effects session is still holding on. Quit After Effects completely and reopen it. If it keeps happening, look for a leftover `CEPHtmlEngine` in Activity Monitor or Task Manager and end it. If the message says no token file was found, your app may be running the tools as a different user or in a sandbox; the panel's log (below) shows where it wrote it. Asking for the same thing again, or reinstalling the panel, won't help. |
| "…updated on disk, but After Effects is still running the previous version" | The update landed; AE just hasn't restarted. Quit and reopen it. Updating again won't help. |
| Panel never loads, but setup looks correct | Ask it to check the setup again — it reads Adobe's own log and says whether the panel's signature was refused. With an unsigned (development) panel on macOS, reboot once: some builds cache the Adobe setting until a restart. |
| A panel answers, but the setup check reports none installed | An older install is still serving. Remove it from the CEP extensions folder, reinstall, restart AE. |
| "No project folder to write to" | Your app didn't tell the server where it's working. Say which folder you want. |
| Style guide can't be saved | The After Effects project has never been saved. Save it, then try again. |
| You need the panel's own log | In After Effects: **Window → Extensions → AE MCP Bridge**. |

About that secret key: every request to the panel must carry it, except one — a
quick "are you there?" health check, which can't read or change anything in
your project. So a panel that answers the health check but refuses real work is
a key problem, not a dead panel.

## Work that legitimately takes longer

A heavy render or a deliberately long script can pass the time limit honestly.
Set `AE_MCP_OP_TIMEOUT_MS` in the server's environment to a larger number of
milliseconds and it applies to every operation. It goes where the read-only
switch goes — the README's [How to turn them on](../README.md#safety-and-privacy)
shows the form for each app (VS Code, Codex, Claude Code and the rest). In an
`mcpServers` app it looks like this:

```json
{
  "mcpServers": {
    "after-effects": {
      "command": "npx",
      "args": ["-y", "@engine-room/after-effects-mcp"],
      "env": { "AE_MCP_OP_TIMEOUT_MS": "600000" }
    }
  }
}
```

In Codex it's `AE_MCP_OP_TIMEOUT_MS = "600000"` under `[mcp_servers.after-effects.env]`;
in Claude Code, re-add the server with `--env AE_MCP_OP_TIMEOUT_MS=600000`.

## The issue notebook

These tools have rough edges. When your assistant hits one and works out a way
around it, it writes the problem and the fix into `.ae-mcp/issues/` in your
project folder — plain text files you can read, edit or delete. The next time
the same thing fails, the error itself points at that note. Notes that go quiet
for a month, or that a newer version has fixed, drop out of the list on their
own (they are kept, just hidden). A note about something the maintainers
already know or have fixed can be retired outright — ask your assistant to
archive it. The folder keeps itself out of version control.

## Reporting a bug

If the problem looks like ours rather than yours, you'll be offered the chance
to pass it on, or you can start it yourself with `/report-ae-issue`. It writes
the report, shows it to you, and only sends it once you say yes. Nothing about
your own work — comp names, file paths, clients — goes into it. Sending needs
the [GitHub CLI](https://cli.github.com); without it you get a prefilled link to
click. You can also [open an issue](https://github.com/Engine-Room-Games/after-effects-mcp/issues)
directly.
