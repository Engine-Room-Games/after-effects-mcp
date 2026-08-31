// mogrt.jsx — export a comp as a Motion Graphics template without the three
// modal dialogs that make a scripted export look like a hung bridge (issue #23).
//
// Measured against AE 26.3 rather than assumed, because the mechanism was
// filed as untested:
//
//   * WITHOUT app.beginSuppressDialogs(), a comp using a non-Adobe font raises
//     "The following 1 fonts were not synced from Adobe … Click OK to continue"
//     and the export blocks. ExtendScript is single-threaded, so the panel
//     cannot service its socket while that dialog is up: the call sat past 60s
//     and no file was written until someone clicked OK.
//   * WITH it, the same export returned in a couple of seconds and produced a
//     valid .mogrt. So suppression is the thing that fixes it, and it is on by
//     default here.
//
// The other two dialogs are handled by construction. `app.project.save()`
// immediately before the export removes the "project needs to be saved" prompt
// deterministically — and the export itself dirties the project, so saving once
// at the start of a session is not enough, it has to be per export. The
// "undo group mismatch" warning is a consequence of running a non-undoable
// export inside dispatch()'s undo group, so this op opts out of the group
// entirely via noUndo.
//
// Two traps that are not in the report, both found by measurement here:
//
//   * The output filename comes from `comp.motionGraphicsTemplateName`, NOT
//     from the comp name, and it defaults to the literal "Untitled" for a
//     template assembled by script. Left alone, every export from every comp in
//     a project writes Untitled.mogrt over the last one.
//   * The export invalidates every object reference held across it, including
//     `app.project`. See the re-fetch below.
//
// And one thing suppression costs, which is the whole of issue #71.
// exportAsMotionGraphicsTemplate reports a boolean and nothing else — AE never
// says *why* it declined — so once dialogs are suppressed a refusal and a
// success-that-wrote-nothing look identical from a script. That silence is
// evidence of nothing in particular, and it must not be read as "a dialog
// blocked us": under beginSuppressDialogs() a blocking dialog is the one cause
// ruled out by construction, because suppressing them is exactly what that call
// did. A comp with an empty Essential Graphics panel is not exportable, and it
// used to come back blaming a dialog that did not exist and offering a remedy
// (retry unsuppressed and click it) that led nowhere. So: check every
// precondition that can be checked *before* the export and name it, and when
// the export still fails, report the cause as unknown rather than as a dialog.

/** Distinct fonts used by the text layers in a comp, following nested comps. */
function __collectFonts(comp, depth, seenComps, fonts) {
  if (depth > 4) return;
  for (var c = 0; c < seenComps.length; c++) { if (seenComps[c] === comp.id) return; }
  seenComps.push(comp.id);

  for (var i = 1; i <= comp.numLayers; i++) {
    var layer = comp.layer(i);
    try {
      if (layer instanceof TextLayer) {
        var doc = layer.property("Source Text").value;
        var f = doc.font;
        if (f) {
          var have = false;
          for (var k = 0; k < fonts.length; k++) { if (fonts[k] === f) { have = true; break; } }
          if (!have) fonts.push(f);
        }
      } else if (layer.source && (layer.source instanceof CompItem)) {
        __collectFonts(layer.source, depth + 1, seenComps, fonts);
      }
    } catch (e) {}
  }
}

function __joinPath(dir, leaf) {
  var d = String(dir);
  if (d.charAt(d.length - 1) === "/" || d.charAt(d.length - 1) === "\\") d = d.substring(0, d.length - 1);
  return d + "/" + leaf;
}

/** AE writes <motionGraphicsTemplateName>.mogrt into the folder it is given. */
function __mogrtFileName(name) {
  return String(name) + ".mogrt";
}

/** Trailing separators off, so two spellings of the same folder compare equal. */
function __trimTrailingSeparator(p) {
  var s = String(p);
  while (s.length > 1) {
    var last = s.charAt(s.length - 1);
    if (last !== "/" && last !== "\\") break;
    s = s.substring(0, s.length - 1);
  }
  return s;
}

function __isBlank(s) {
  var t = String(s);
  for (var i = 0; i < t.length; i++) {
    var ch = t.charAt(i);
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return false;
  }
  return true;
}

/**
 * How many controllers the comp's Essential Graphics panel holds, or null when
 * the host will not say.
 *
 * null is not zero. A read that throws means this AE cannot be asked, and
 * refusing an export on the strength of a question that was never answered
 * would be its own confidently wrong diagnosis. Only an explicit 0 refuses.
 */
function __controllerCount(comp) {
  var n = null;
  try { n = comp.motionGraphicsTemplateControllerCount; } catch (e) { return null; }
  if (typeof n !== "number") return null;
  return n;
}

/**
 * Whether After Effects can actually write into the destination folder.
 *
 * ExtendScript has no permission API, so the only reliable test is to write.
 * A folder that exists and refuses writes is another cause the export reports
 * as nothing at all, and it is worth naming before spending the export rather
 * than after. The probe is removed on every path; it never outlives the call.
 */
function __folderIsWritable(folder) {
  var probe = new File(__joinPath(folder.fsName, ".ae-mcp-write-probe"));
  var opened = false;
  try {
    opened = probe.open("w");
    if (opened) probe.write("");
  } catch (eW) {
    opened = false;
  }
  try { probe.close(); } catch (eC) {}
  try { if (probe.exists) probe.remove(); } catch (eR) {}
  return opened === true;
}

/**
 * The failure message for an export that wrote nothing.
 *
 * Built rather than fixed, because the only honest message names what was
 * actually established and stops there. `suppressed` is the hinge: with dialogs
 * suppressed a modal cannot be the cause and must not be mentioned as one
 * (issue #71); without suppression it is the first thing to look at. Everything
 * after that is unknown, and says so — AE's own UI is the only place the real
 * reason exists, which is why the diagnostic step is to run the export by hand.
 */
function __exportFailureMessage(info) {
  var lines = [];
  lines.push(
    "After Effects did not write a template. It returned " + String(info.exported) +
    " and there is no file at " + info.outPath + "."
  );
  lines.push(
    "Ruled out before the export ran: the project is saved (" + info.projectPath + "); the destination " +
    "folder exists and accepts writes; the template name resolves to that folder; and the comp has " +
    info.controllerText + "."
  );
  if (!info.suppressed) {
    lines.push(
      "Dialogs were NOT suppressed for this call, so a modal dialog waiting in After Effects is the " +
      "likeliest cause — switch to After Effects and look for one. Retry with the default " +
      "suppressDialogs:true once it is cleared."
    );
  } else {
    lines.push(
      "Dialogs were suppressed, so a modal dialog cannot be what stopped this — do not go looking for " +
      "one to click. After Effects reported no reason at all, and there is no reason for a script to " +
      "read, so the cause is unknown."
    );
    lines.push(
      "To find out what After Effects would have said, ask the user to export the same comp by hand: " +
      "Window > Essential Graphics, select the comp, then Export Motion Graphics Template. After " +
      "Effects shows its own error there. Running this tool again with suppressDialogs:false shows the " +
      "same dialog, but it will freeze this connection until someone clicks it."
    );
  }
  return lines.join(" ");
}

OPS.export_mogrt = noUndo(function (args) {
  var comp = getCompById(args.compId);

  // The save prompt is the first dialog, and the only way to remove it without
  // guessing is to have somewhere to save to. A project that has never been
  // saved has no file and no folder — the user has to do that once by hand,
  // which is worth saying rather than raising a dialog they did not expect.
  if (!app.project.file) {
    throw new Error(
      "This After Effects project has never been saved, so the export cannot save it first and " +
      "After Effects would raise a modal 'save the project?' dialog that freezes this connection " +
      "until someone clicks it. Ask the user to save the project once, then call export_mogrt again."
    );
  }

  // Every precondition that can be established from a script runs here, before
  // the project is touched at all: the template is not renamed, the project is
  // not saved and no export is attempted until they all pass. A refusal below
  // therefore costs the user nothing and names its own remedy — which is the
  // whole point, since a failure *after* the export names nothing.

  // The Essential Graphics panel has to have something in it. AE will not build
  // a template with no controllers, and under suppression it declines without a
  // word — which is what made this look like a dialog (issue #71). An explicit
  // 0 is the whole diagnosis; a count the host refuses to give is not.
  var preControllerCount = __controllerCount(comp);
  if (preControllerCount === 0) {
    throw new Error(
      "This comp has 0 Essential Graphics controllers, and After Effects cannot export a template " +
      "from a comp with an empty Essential Graphics panel. It refuses without writing a file and " +
      "without reporting anything a script can read, so nothing was exported and nothing in the " +
      "project was changed. To fix it, put at least one property into the panel: in After Effects " +
      "open Window > Essential Graphics, pick this comp in the panel's dropdown, then drag a layer " +
      "property into it — a text layer's Source Text, a colour, a slider, a position. Then call " +
      "export_mogrt again."
    );
  }

  var templateName = (typeof args.name === "string" && args.name.length > 0) ? args.name : null;
  var previousTemplateName = null;
  try { previousTemplateName = comp.motionGraphicsTemplateName; } catch (e) {}
  if (!templateName) {
    // AE's own default is "Untitled" for a template built by script, which
    // silently collides with every other comp in the project. The comp name is
    // what the user would have typed. A name they *did* type is left alone.
    if (!previousTemplateName || previousTemplateName === "Untitled") {
      templateName = comp.name;
    } else {
      templateName = previousTemplateName;
    }
  }
  if (__isBlank(templateName)) {
    throw new Error(
      "The template name is empty, and it becomes the .mogrt filename. Pass a `name`."
    );
  }

  var destDir = (typeof args.destDir === "string" && args.destDir.length > 0)
    ? args.destDir
    : app.project.file.parent.fsName;
  var folder = new Folder(destDir);
  var createdDir = false;
  if (!folder.exists) {
    if (!folder.create()) throw new Error("Could not create the destination folder " + destDir);
    createdDir = true;
  }

  var outPath = __joinPath(folder.fsName, __mogrtFileName(templateName));
  var outFile = new File(outPath);

  // The name becomes a filename, so a separator in it sends the write somewhere
  // else — or nowhere, silently. Measured rather than pattern-matched: ask the
  // File where it actually landed and compare. That works the same on both
  // platforms, which a list of illegal characters would not.
  var resolvedParent = null;
  try { resolvedParent = outFile.parent.fsName; } catch (eP) {}
  if (resolvedParent !== null &&
      __trimTrailingSeparator(resolvedParent) !== __trimTrailingSeparator(folder.fsName)) {
    throw new Error(
      "The template name \"" + templateName + "\" is used as the .mogrt filename, and it resolves to " +
      outPath + ", which is not inside " + folder.fsName + ". Pass a `name` with no slashes in it, and " +
      "a `destDir` if you want it written somewhere else."
    );
  }

  var existed = outFile.exists;
  if (existed && args.overwrite !== true) {
    throw new Error(
      "A template already exists at " + outPath + ". Pass overwrite: true to replace it, or a " +
      "different `name`."
    );
  }

  // Last of the checkable preconditions, and the last thing that costs nothing
  // to get wrong. A folder that will not accept a file is one more cause the
  // export reports as silence.
  if (!__folderIsWritable(folder)) {
    throw new Error(
      "After Effects cannot write into " + folder.fsName + " — a test file could not be created there. " +
      "Nothing was exported. Pass a `destDir` the user can write to, or ask them to fix the folder's " +
      "permissions."
    );
  }

  var fonts = [];
  try { __collectFonts(comp, 0, [], fonts); } catch (eF) {}

  if (templateName !== previousTemplateName) comp.motionGraphicsTemplateName = templateName;

  // Saving is what removes the save prompt, and it has to happen per export:
  // exporting dirties the project, so a project saved before the first export
  // is dirty again before the second.
  app.project.save();

  // Everything the result needs, read *before* the export. See below.
  var compId = comp.id;
  var compName = comp.name;
  var projectPath = app.project.file.fsName;

  var suppress = args.suppressDialogs !== false;
  var suppressed = false;
  var exported;
  try {
    if (suppress) { app.beginSuppressDialogs(); suppressed = true; }
    exported = comp.exportAsMotionGraphicsTemplate(true, folder.fsName);
  } finally {
    // Unconditional: leaving dialogs suppressed would silence every warning in
    // the rest of the user's session, including ones they need to see.
    if (suppressed) { try { app.endSuppressDialogs(false); } catch (eS) {} }
  }

  // exportAsMotionGraphicsTemplate invalidates every object reference held
  // across it — the CompItem, and `app.project` itself. Measured, not assumed:
  // after a successful export, `comp.name` and a captured `app.project.file`
  // both throw "Object is invalid", while a fresh `app.project.itemByID(id)`
  // returns a working comp. Reading through a stale handle here would report a
  // failure for an export that had already written a valid file, which is the
  // same lie as swallowing an error, just pointing the other way.
  comp = getCompById(compId);

  // exportAsMotionGraphicsTemplate returns a boolean, and a false is the whole
  // failure report AE offers. Check the file too — a truthy return with nothing
  // on disk is exactly the kind of success-for-work-that-did-not-happen this
  // codebase refuses to pass on.
  var written = new File(outPath);
  if (!written.exists) {
    var controllerText;
    if (preControllerCount === null) {
      controllerText = "controllers this version of After Effects would not count";
    } else if (preControllerCount === 1) {
      controllerText = "1 Essential Graphics controller";
    } else {
      controllerText = String(preControllerCount) + " Essential Graphics controllers";
    }
    throw new Error(__exportFailureMessage({
      exported: exported,
      outPath: outPath,
      projectPath: projectPath,
      suppressed: suppress,
      controllerText: controllerText
    }));
  }
  var bytes = written.length;
  if (!(bytes > 0)) throw new Error("The exported template at " + outPath + " is empty (0 bytes).");

  var result = {
    ok: true,
    path: outPath,
    bytes: bytes,
    name: templateName,
    compId: compId,
    compName: compName,
    replaced: existed,
    createdDir: createdDir,
    projectSaved: app.project.file.fsName,
    dialogsSuppressed: suppress,
    // Re-read rather than echoed: the export is the only thing that can change
    // it, and a host that will not answer says null instead of a made-up 0.
    controllerCount: __controllerCount(comp),
    fonts: fonts
  };
  if (!suppress) {
    result.warning =
      "Dialogs were not suppressed. If this call took a long time, a modal font warning was waiting " +
      "in After Effects.";
  }

  // The thumbnail. AE has no scriptable poster time — CompItem.posterTime does
  // not exist — and the export ignores comp.time, so thumb.png inside the
  // .mogrt is whatever AE decided, usually black. Render the requested frame
  // here and let the panel put it into the archive: ExtendScript can write a
  // PNG but cannot rewrite a zip, and the panel is already the layer that
  // post-processes files AE has just written.
  if (args.posterTime !== undefined && args.posterTime !== null) {
    var t = args.posterTime;
    if (t < 0 || t > comp.duration) {
      throw new Error(
        "posterTime " + t + " is outside the comp's 0.." + comp.duration + "s. The template was still " +
        "exported to " + outPath + " with After Effects' own thumbnail."
      );
    }
    var posterPath = __tmpPngPath();
    __saveFrameAt(comp, t, new File(posterPath), 1);
    result.posterPngPath = posterPath;
    result.posterTime = t;
  }

  return result;
});
