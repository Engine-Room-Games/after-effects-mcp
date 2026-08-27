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

  var templateName = (typeof args.name === "string" && args.name.length > 0) ? args.name : null;
  var previousTemplateName = null;
  try { previousTemplateName = comp.motionGraphicsTemplateName; } catch (e) {}
  if (!templateName) {
    // AE's own default is "Untitled" for a template built by script, which
    // silently collides with every other comp in the project. The comp name is
    // what the user would have typed. A name they *did* type is left alone.
    templateName = (!previousTemplateName || previousTemplateName === "Untitled") ? comp.name : previousTemplateName;
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
  var existed = outFile.exists;
  if (existed && args.overwrite !== true) {
    throw new Error(
      "A template already exists at " + outPath + ". Pass overwrite: true to replace it, or a " +
      "different `name`."
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
    throw new Error(
      "After Effects reported " + String(exported) + " for the export but no file appeared at " + outPath +
      ". If suppressDialogs was false, a modal dialog in After Effects may have cancelled it."
    );
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
    controllerCount: comp.motionGraphicsTemplateControllerCount,
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
