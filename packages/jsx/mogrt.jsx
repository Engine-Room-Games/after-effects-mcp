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

  // A read-only .aep cannot be saved, and under suppression the save would
  // simply not happen; unsuppressed it is a modal. Either way, refuse first.
  var projectReadOnly = null;
  try { projectReadOnly = app.project.file.readonly === true; } catch (eRO) { projectReadOnly = null; }
  if (projectReadOnly === true) {
    throw new Error(
      "The project file " + app.project.file.fsName + " is read-only, so it cannot be saved before the " +
      "export, which After Effects requires. Nothing was exported and nothing in the project was changed. " +
      "Ask the user to make it writable or Save As somewhere else, then call export_mogrt again."
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
      "project was changed. To fix it, put at least one property into the panel with " +
      "add_essential_property — a text layer's Source Text, a colour, a slider, a position — or have " +
      "the user drag one in by hand from Window > Essential Graphics with this comp picked in the " +
      "panel's dropdown. Then call export_mogrt again."
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

  // posterTime is checked here, with the other preconditions, so a bad one
  // costs nothing: after the save and the export it would leave the user with
  // a saved project and a template they did not ask for.
  var hasPoster = args.posterTime !== undefined && args.posterTime !== null;
  if (hasPoster && (args.posterTime < 0 || args.posterTime > comp.duration)) {
    throw new Error(
      "posterTime " + args.posterTime + " is outside the comp's 0.." + comp.duration + "s. Nothing was " +
      "exported and nothing in the project was changed. Pass a time inside the comp."
    );
  }

  var fonts = [];
  try { __collectFonts(comp, 0, [], fonts); } catch (eF) {}

  if (templateName !== previousTemplateName) comp.motionGraphicsTemplateName = templateName;

  // Everything the result needs, read *before* the export. See below.
  var compId = comp.id;
  var compName = comp.name;
  var projectPath = app.project.file.fsName;

  // Saving is what removes the save prompt, and it has to happen per export:
  // exporting dirties the project, so a project saved before the first export
  // is dirty again before the second. It happens INSIDE the suppressed block:
  // a save can raise its own modal (a locked file, a project converted from an
  // older version that only Save As will write), which would freeze this
  // connection. Under suppression such a save just does not happen, so the
  // dirty flag is checked afterwards rather than trusted, as _render_save does
  // (render.jsx). A project with no unsaved changes is not saved at all.
  //
  // dispatch() leaves dialogs to this op (__meta.ownDialogs below), so it also
  // collects what After Effects reports through app.onError itself, with the
  // same guard dispatch() uses, and puts it on the result as `aeWarnings`.
  var suppress = args.suppressDialogs !== false;
  var suppressed = false;
  var guard = null;
  var exported;
  var projectSaved = false;
  var threw = null;
  var saveFailed = null;
  var saveWarning = null;
  var suppressFailed = null;
  try {
    var already = typeof __dialogsSuppressed === "function" && __dialogsSuppressed();
    if (suppress && !already) {
      if (typeof __dialogGuardStart === "function") {
        guard = __dialogGuardStart();
        // A null guard here means the guard is switched off (__DIALOG_GUARD)
        // or beginSuppressDialogs() threw inside it. Only the first may begin
        // suppression by hand; the second is a refusal, never a retry.
        if (!guard && (typeof __DIALOG_GUARD === "undefined" || __DIALOG_GUARD)) {
          suppressFailed = "After Effects would not suppress its dialogs (beginSuppressDialogs failed), so " +
            "the save and the export were not attempted: either could raise a modal dialog that freezes " +
            "this connection. Nothing was saved or exported. Try again once After Effects is idle.";
        }
      }
      if (!guard && !suppressFailed) {
        try { app.beginSuppressDialogs(); } catch (eB) {
          suppressFailed = "After Effects would not suppress its dialogs (" + eB.message + "), so the save " +
            "and the export were not attempted: either could raise a modal dialog that freezes this " +
            "connection. Nothing was saved or exported. Try again once After Effects is idle.";
        }
      }
      if (!suppressFailed) suppressed = true;
    }
    if (suppressFailed) throw new Error(suppressFailed);
    var wasDirty = null;
    try { wasDirty = app.project.dirty; } catch (eD) { wasDirty = null; }
    if (wasDirty !== false) {
      var saveThrew = null;
      try { app.project.save(); } catch (eSave) { saveThrew = eSave; }
      // dirtyAfter: true, false, or null when the host will not say.
      var dirtyAfter = null;
      try { dirtyAfter = app.project.dirty === true ? true : (app.project.dirty === false ? false : null); } catch (eD2) { dirtyAfter = null; }
      // A save that threw but left the project clean most likely landed: it is
      // reported as a save (the Revert point moved), with what AE threw. A
      // throw with no readable dirty flag proves nothing, so it is a refusal.
      var stillDirty = dirtyAfter === true || (saveThrew !== null && dirtyAfter !== false);
      if (!stillDirty && saveThrew) {
        saveWarning = "After Effects threw while saving the project (" + saveThrew.message + "), but the " +
          "project reads as saved afterwards, so the save most likely landed.";
      }
      if (stillDirty) {
        saveFailed = "After Effects did not save the project (" + projectPath + ")" +
          (saveThrew ? ": " + saveThrew.message : "") + ", and it has to be saved before an export. Nothing " +
          "was exported. The usual causes are a file that is locked or read-only, or a project converted " +
          "from an older version of After Effects, which only File > Save As will write. Ask the user to " +
          "save it by hand, then call export_mogrt again.";
      } else {
        projectSaved = true;
      }
    }
    if (!saveFailed) exported = comp.exportAsMotionGraphicsTemplate(true, folder.fsName);
  } catch (eX) {
    threw = eX;
  } finally {
    // Unconditional: leaving dialogs suppressed would silence every warning in
    // the rest of the user's session, including ones they need to see.
    if (suppressed) {
      if (guard) { try { __dialogGuardEnd(guard); } catch (eG) {} }
      else { try { app.endSuppressDialogs(false); } catch (eS) {} }
    }
  }
  var aeWarnings = (guard && guard.messages && guard.messages.length) ? guard.messages : null;
  function withWarnings(msg) {
    return aeWarnings
      ? msg + " || After Effects also reported, through app.onError while dialogs were suppressed: " + aeWarnings.join(" | ")
      : msg;
  }
  var renamed = templateName !== previousTemplateName && previousTemplateName !== null;
  // The template rename is the one change this call makes to the project; a
  // failure puts it back. The export invalidates held references, so the comp
  // is fetched fresh.
  function undoRename() {
    if (!renamed) return false;
    try { getCompById(compId).motionGraphicsTemplateName = previousTemplateName; return true; } catch (eR) { return false; }
  }
  // A failure after a save that landed: the save stays, and the user has to
  // know their Revert point moved.
  function failAfterSave(msg) {
    var undone = undoRename();
    if (renamed === false && templateName !== previousTemplateName) {
      msg += " The comp's Essential Graphics template name was set to '" + templateName + "' for the export; " +
        "its previous name could not be read, so it was not put back.";
    }
    if (projectSaved) {
      msg += " NOTE: the user's project WAS saved (" + projectPath + ") before the export, so File > Revert " +
        "now goes back to that save — tell the user." +
        (undone ? " The template name set for the export ('" + templateName + "') is in that saved file; it " +
          "was put back to '" + previousTemplateName + "' in the open project, which now has unsaved changes." : "");
    }
    return new Error(withWarnings(msg));
  }
  if (saveFailed) throw failAfterSave(saveFailed);
  if (threw) {
    if (!aeWarnings && !projectSaved && !undoRename()) throw threw;
    throw failAfterSave(threw && threw.message ? threw.message : String(threw));
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
    throw failAfterSave(__exportFailureMessage({
      exported: exported,
      outPath: outPath,
      projectPath: projectPath,
      suppressed: suppress,
      controllerText: controllerText
    }));
  }
  var bytes = written.length;
  if (!(bytes > 0)) throw failAfterSave("The exported template at " + outPath + " is empty (0 bytes).");

  var result = {
    ok: true,
    path: outPath,
    bytes: bytes,
    name: templateName,
    compId: compId,
    compName: compName,
    replaced: existed,
    createdDir: createdDir,
    // Whether THIS call saved the user's project. A save moves what File >
    // Revert goes back to, so the agent has to be able to tell the user.
    projectSaved: projectSaved,
    projectPath: projectPath,
    dialogsSuppressed: suppress,
    // Re-read rather than echoed: the export is the only thing that can change
    // it, and a host that will not answer says null instead of a made-up 0.
    controllerCount: __controllerCount(comp),
    fonts: fonts
  };
  if (projectSaved) {
    result.projectSavedNote =
      "The user's project was saved (" + projectPath + ") before the export, which After Effects requires. " +
      "Tell the user: File > Revert now goes back to this state, not to their last save.";
  }
  if (saveWarning) result.saveWarning = saveWarning;
  if (aeWarnings) result.aeWarnings = aeWarnings;
  if (!suppress) {
    result.warning =
      "Dialogs were not suppressed. If this call took a long time, a modal font warning was waiting " +
      "in After Effects.";
  }

  // The thumbnail. AE has no scriptable poster time — CompItem.posterTime does
  // not exist — and the export ignores comp.time, so thumb.png inside the
  // .mogrt is whatever AE decided, usually black. Render the requested frame
  // here and let the panel (or, on a server-images panel, the server) put it into the archive: ExtendScript can write a
  // PNG but cannot rewrite a zip, and the panel is already the layer that
  // post-processes files AE has just written.
  if (hasPoster) {
    var t = args.posterTime;
    // The template is written and valid by now (and the project may have been
    // saved): a poster frame that fails to render is a warning on a success,
    // never a failure that hides both.
    try {
      var posterPath = __tmpPngPath();
      __saveFrameAt(comp, t, new File(posterPath), 1);
      result.posterPngPath = posterPath;
      result.posterTime = t;
    } catch (ePoster) {
      result.posterWarning = "The template was exported, but the poster frame at " + t + "s could not be " +
        "rendered (" + (ePoster && ePoster.message ? ePoster.message : String(ePoster)) + "), so it keeps " +
        "After Effects' own thumbnail.";
    }
  }

  // After Effects marks the project changed after every export, saved or not
  // (measured on 26.5: a second export in a row always saves again). That is
  // AE's doing and not fought here; it is said, so an agent does not read
  // the unsaved-changes star as something it did. Read through a fresh
  // `app.project`: the export invalidated the one held before it.
  var dirtyAfterExport = null;
  try { dirtyAfterExport = app.project.dirty === true ? true : (app.project.dirty === false ? false : null); } catch (eDA) {}
  result.projectDirty = dirtyAfterExport;
  if (dirtyAfterExport === true) {
    result.note =
      "The export left the project with unsaved changes: After Effects marks a project changed after " +
      "every export, even when nothing in it changed. Nothing is lost; the next export_mogrt saves it " +
      "again first. Tell the user only if they ask why the project shows unsaved changes.";
  }

  return result;
});
// dispatch() leaves dialogs to this op (core.jsx, "Dialog guard"):
// suppressDialogs:false has to mean the dialog is shown. Inside run_batch the
// batch's suppression is already on and the export does not begin its own.
if (!OPS.export_mogrt.__meta) OPS.export_mogrt.__meta = {};
OPS.export_mogrt.__meta.ownDialogs = true;
// The same export under an internal name (issue #220, stage 4): the panel does
// not intercept it, so `posterPngPath` comes back and the server folds the
// poster into the template itself. The same function object, so ownDialogs
// above holds for both names.
OPS._export_mogrt = OPS.export_mogrt;

// ---------- add_essential_property (issue #177) ----------
//
// export_mogrt refuses a comp with an empty Essential Graphics panel (#71), and
// until this op the only way to fill the panel was the user dragging a
// property in by hand. The scripting API has had the call since AE 16.1:
// `Property.addToMotionGraphicsTemplate(comp)` and
// `addToMotionGraphicsTemplateAs(comp, name)`, with
// `canAddToMotionGraphicsTemplate(comp)` as the up-front question.
//
// What is known and what is not. The add returns a boolean; whether a false is
// ever accompanied by a controller anyway, whether adding the same property
// twice makes a second controller, and which end of the list
// `getMotionGraphicsTemplateControllerName(index)` puts the new one at were
// all unmeasured when this was written. So nothing here leans on any of them:
// the controller count and the full list of controller names are read before
// and after, the new controller is found by comparing the two lists, and the
// result reports what the panel actually holds afterwards. A call that leaves
// the count where it was is a refusal whatever the boolean said.

/** Every controller name in the comp's panel, or null when the host will not list them. */
function __controllerNames(comp, count) {
  if (typeof count !== "number") return null;
  var names = [];
  try {
    for (var i = 1; i <= count; i++) names.push(String(comp.getMotionGraphicsTemplateControllerName(i)));
  } catch (e) { return null; }
  return names;
}

/**
 * Every 1-based index in `after` that could be the one new controller: `after`
 * has exactly one more entry, and a candidate is an index whose removal leaves
 * `before` unchanged. Order-agnostic on purpose — see the header. With
 * duplicate names there can be several (a second "Title" next to an old one),
 * and then which of them is new cannot be told from names alone; the caller
 * must not guess, because a rename aimed at a guess can hit a controller the
 * user already had. null when the lists cannot be compared at all.
 */
function __newControllerCandidates(before, after) {
  if (!before || !after || after.length !== before.length + 1) return null;
  var found = [];
  for (var i = 0; i < after.length; i++) {
    var same = true;
    for (var j = 0, k = 0; j < before.length; j++, k++) {
      if (k === i) k++;
      if (after[k] !== before[j]) { same = false; break; }
    }
    if (same) found.push(i + 1);
  }
  return found;
}

function __propertyValueTypeLabel(prop) {
  var t;
  try { t = prop.propertyValueType; } catch (e) { return "unknown"; }
  var names = ["NO_VALUE", "ThreeD_SPATIAL", "ThreeD", "TwoD_SPATIAL", "TwoD", "OneD", "COLOR",
    "CUSTOM_VALUE", "MARKER", "LAYER_INDEX", "MASK_INDEX", "SHAPE", "TEXT_DOCUMENT"];
  try {
    for (var i = 0; i < names.length; i++) {
      if (PropertyValueType[names[i]] === t) return names[i];
    }
  } catch (e2) {}
  return String(t);
}

/** A controller already named like this property (or the requested name), or null. */
function __duplicateControllerName(comp, prop, requested) {
  var names = __controllerNames(comp, __controllerCount(comp));
  if (!names) return null;
  var own = null;
  try { own = String(prop.name); } catch (e) {}
  for (var i = 0; i < names.length; i++) {
    if ((own !== null && names[i] === own) || (requested !== null && names[i] === requested)) return names[i];
  }
  return null;
}

/** Value types the Essential Graphics panel takes, by AE's own enum. */
function __isAddableValueType(prop) {
  var t = __propertyValueTypeLabel(prop);
  return t === "TEXT_DOCUMENT" || t === "COLOR" || t === "OneD" || t === "TwoD" || t === "TwoD_SPATIAL";
}

OPS.add_essential_property = function (args) {
  var comp = getCompById(args.compId);
  var layer = getLayerById(comp, args.layerId);
  var prop = walkProperty(layer, args.propertyPath);
  var label = __propertyPathLabel(args.propertyPath);
  var hasName = typeof args.name === "string" && args.name.length > 0;
  if (hasName && __isBlank(args.name)) {
    throw new Error("The controller name is blank. Pass a name with something in it, or omit `name` for the property's own.");
  }

  var isLeaf = false;
  try { isLeaf = prop.propertyType === PropertyType.PROPERTY; } catch (eT) {}
  if (!isLeaf) {
    throw new Error(
      label + " is a property group, not a property, and only a single property can go into Essential " +
      "Graphics. Name a leaf under it — get_layer_full lists them. Nothing was added."
    );
  }

  if (typeof prop.canAddToMotionGraphicsTemplate !== "function" ||
      typeof prop.addToMotionGraphicsTemplate !== "function") {
    throw new Error(
      "This version of After Effects has no scripting call for adding a property to Essential Graphics " +
      "(it arrived in After Effects 16.1). Nothing was added. Ask the user to drag " + label +
      " into Window > Essential Graphics by hand."
    );
  }
  if (hasName && typeof prop.addToMotionGraphicsTemplateAs !== "function") {
    throw new Error(
      "This version of After Effects cannot name a controller as it adds it. Nothing was added. Call " +
      "again without `name` to keep the property's own name."
    );
  }

  var can = false;
  try { can = prop.canAddToMotionGraphicsTemplate(comp) === true; } catch (eC) { can = false; }
  if (!can) {
    // Measured live (#211 review): AE also answers false for a property that
    // is already in the panel, and the "wrong kind" message below sent the
    // reader to expression controls for a Source Text that was simply there.
    // No API maps a controller back to its property, so this is matched by
    // name — the property's own, or the one asked for — and, failing that, a
    // value type the panel normally takes is reported as probably present.
    var dup = __duplicateControllerName(comp, prop, hasName ? args.name : null);
    if (dup !== null) {
      throw new Error(
        label + " is already in the Essential Graphics panel as \"" + dup + "\", so After Effects will " +
        "not add it again. Nothing was added. Its controller is already there for export_mogrt; rename it " +
        "by hand in Window > Essential Graphics if the label is wrong."
      );
    }
    if (__isAddableValueType(prop)) {
      throw new Error(
        "After Effects refused to add " + label + " (value type " + __propertyValueTypeLabel(prop) + "), " +
        "a kind the Essential Graphics panel normally takes, so it is most likely already in the panel " +
        "under another name. Nothing was added. Check Window > Essential Graphics for this comp."
      );
    }
    throw new Error(
      "After Effects says " + label + " (value type " + __propertyValueTypeLabel(prop) + ") cannot go " +
      "into this comp's Essential Graphics panel. It takes Source Text, colours, checkboxes, single " +
      "numbers such as sliders, angles and opacity, 2D points such as position and scale, and dropdown " +
      "menus; it refuses paths, masks, markers, layer pickers and a property that belongs to a different " +
      "comp. Nothing was added. To expose a value of another kind, put an expression control (a slider, " +
      "colour, checkbox, point or dropdown effect) on the layer, drive " + label + " from it with an " +
      "expression, and add the control's property instead."
    );
  }

  var beforeCount = __controllerCount(comp);
  var beforeNames = __controllerNames(comp, beforeCount);

  var added;
  if (hasName) added = prop.addToMotionGraphicsTemplateAs(comp, args.name);
  else added = prop.addToMotionGraphicsTemplate(comp);

  var afterCount = __controllerCount(comp);
  if (typeof beforeCount === "number" && typeof afterCount === "number" && afterCount <= beforeCount) {
    throw new Error(
      "After Effects did not add " + label + " to the Essential Graphics panel: it returned " +
      String(added) + " and the panel still holds " + afterCount + " controller" +
      (afterCount === 1 ? "" : "s") + ". If the property is already in the panel, that is the likeliest " +
      "reason — it is not added twice. Nothing was changed."
    );
  }
  if (added !== true && (typeof beforeCount !== "number" || typeof afterCount !== "number")) {
    throw new Error(
      "After Effects returned " + String(added) + " for adding " + label + " to the Essential Graphics " +
      "panel and will not report a controller count, so whether anything was added cannot be told. " +
      "Ask the user to check Window > Essential Graphics for this comp."
    );
  }

  var afterNames = __controllerNames(comp, afterCount);
  var candidates = __newControllerCandidates(beforeNames, afterNames);
  var index = (candidates && candidates.length === 1) ? candidates[0] : null;
  // Several candidates all carry the same name (that is the only way removal of
  // different indices can leave the same list), so the label is known even
  // when the position is not.
  var controllerName = (candidates && candidates.length > 0) ? afterNames[candidates[0] - 1] : null;
  var ambiguous = !!(candidates && candidates.length > 1);

  if (hasName && ambiguous && controllerName !== args.name) {
    throw new Error(
      label + " was added to the Essential Graphics panel, but under the name \"" + controllerName +
      "\", not \"" + args.name + "\". The panel already had a controller of that name, so which of " +
      "them is the new one cannot be told, and it was not renamed rather than risk renaming the " +
      "user's existing one. Undo this step to remove it, or rename it by hand in Window > Essential Graphics."
    );
  }

  // The name AE gave it is checked, not assumed. One correction attempt via
  // setMotionGraphicsControllerName on the index just found; a label that
  // still disagrees is reported as a failure, because the controller exists
  // under a name the caller did not ask for.
  if (hasName && index !== null && controllerName !== args.name) {
    try { comp.setMotionGraphicsControllerName(index, args.name); } catch (eN) {}
    try { controllerName = String(comp.getMotionGraphicsTemplateControllerName(index)); } catch (eR) {}
    if (controllerName !== args.name) {
      throw new Error(
        label + " was added to the Essential Graphics panel, but under the name \"" + controllerName +
        "\", not \"" + args.name + "\", and renaming it did not take. The controller is in the panel; " +
        "undo this step to remove it, or rename it by hand in Window > Essential Graphics."
      );
    }
  }

  var templateName = null;
  try { templateName = String(comp.motionGraphicsTemplateName); } catch (eM) {}

  var result = {
    ok: true,
    compId: comp.id,
    layerId: layer.id,
    propertyPath: args.propertyPath,
    controllerIndex: index,
    controllerName: controllerName,
    controllerCount: afterCount,
    templateName: templateName
  };
  if (ambiguous) {
    result.note =
      "The controller was added as \"" + controllerName + "\", but the panel holds more than one " +
      "controller of that name, so which index is the new one cannot be told (candidates: " +
      candidates.join(", ") + ").";
  } else if (index === null) {
    result.note =
      "The controller was added, but After Effects would not list the panel's controller names, so its " +
      "index and label could not be read back" + (hasName ? ", and whether it carries the name asked for " +
      "is unconfirmed" : "") + ".";
  }
  return result;
};
