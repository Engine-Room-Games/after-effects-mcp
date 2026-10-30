# Uninstalling

Quit After Effects first, then remove whichever pieces you have. Your
`house-style.md` files and project folders are yours and are never touched.

Back to the [README](../README.md).

1. **The tools.** Claude Desktop: remove the After Effects extension in Settings → Extensions. Claude Code plugin: `/plugin uninstall after-effects@engine-room`. Anywhere else: delete the `after-effects` entry from your app's MCP configuration (and the unzipped folder, if you used the standalone download).
2. **The panel.** Delete the folder `games.engine-room.ae-mcp` from the CEP extensions folder:
   - macOS: `~/Library/Application Support/Adobe/CEP/extensions/games.engine-room.ae-mcp`
   - Windows: `%APPDATA%\Adobe\CEP\extensions\games.engine-room.ae-mcp`
3. **The small files it keeps in your user folder.** `~/.engineroom-ae-mcp` holds the panel's port, its secret key and, if you ever created one, a `config.json` with port settings; `~/.ae-mcp` and `~/.after-effects-mcp` hold issue notes, if any were written there. All three are safe to delete. Notes kept inside a project live in that project's `.ae-mcp` folder.
4. **Adobe's debug setting** — only if nothing else you use needs it. Setup turned on `PlayerDebugMode` (and CEP logging) for CEP versions 9 to 12. Released panels are signed and don't need it — setup sets it only as a fallback — but other unsigned Adobe panels rely on the same setting, so leave it on if you have any. To turn it off:
   - macOS: `for v in 9 10 11 12; do defaults delete com.adobe.CSXS.$v PlayerDebugMode; done`
   - Windows (Command Prompt): `for %v in (9 10 11 12) do reg delete HKCU\Software\Adobe\CSXS.%v /v PlayerDebugMode /f`

   Setup only turned CEP logging on where it had never been set, so unless you set a log level yourself, remove that too:
   - macOS: `for v in 9 10 11 12; do defaults delete com.adobe.CSXS.$v LogLevel; done`
   - Windows (Command Prompt): `for %v in (9 10 11 12) do reg delete HKCU\Software\Adobe\CSXS.%v /v LogLevel /f`
