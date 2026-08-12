// style.jsx — the project's house style, read from and written to a plain
// markdown file sitting next to the .aep.
//
// Why here rather than in the MCP server: the bridge into After Effects is the
// one channel every client has, because the whole product already depends on it.
// A server-side file would need a project folder, and the clients that matter
// most here are exactly the ones that do not have one — Claude Desktop starts
// its servers at the filesystem root. Reading the style over the bridge needs no
// working directory, no filesystem tools on the client, and no configuration.
//
// The cost is that the project must have been saved once. `app.project.file` is
// null until then, and there is no folder to write into. That is reported, never
// guessed around.

var HOUSE_STYLE_FILENAME = "house-style.md";

/** The .aep's folder, or null when the project has never been saved. */
function __projectFolder() {
  var f = app.project.file;
  if (!f) return null;
  return f.parent;
}

function __houseStyleFile() {
  var folder = __projectFolder();
  if (!folder) return null;
  return new File(folder.fsName + "/" + HOUSE_STYLE_FILENAME);
}

/** Shared shape for "there is nowhere to put it", so both ops explain it the same way. */
function __unsavedProject() {
  return {
    found: false,
    projectSaved: false,
    path: null,
    content: null,
    reason:
      "This After Effects project has never been saved, so there is no folder to keep the style guide in. " +
      "Ask the user to save the project, then try again."
  };
}

OPS.get_house_style = noUndo(function () {
  var file = __houseStyleFile();
  if (!file) return __unsavedProject();

  if (!file.exists) {
    return {
      found: false,
      projectSaved: true,
      path: file.fsName,
      content: null,
      reason: "No style guide for this project yet. Offer to capture one from a comp the user likes."
    };
  }

  // UTF-8 explicitly: ExtendScript otherwise decodes with the system encoding,
  // which mangles any non-ASCII the designer typed (curly quotes, em dashes,
  // accented font names).
  file.encoding = "UTF-8";
  if (!file.open("r")) throw new Error("Could not open " + file.fsName + " for reading");
  var content;
  try { content = file.read(); }
  finally { file.close(); }

  return {
    found: true,
    projectSaved: true,
    path: file.fsName,
    content: content,
    bytes: content.length
  };
});

OPS.set_house_style = noUndo(function (args) {
  var content = args && args.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("content is required and must not be empty");
  }

  var file = __houseStyleFile();
  if (!file) {
    var unsaved = __unsavedProject();
    throw new Error(unsaved.reason);
  }

  var existed = file.exists;
  // Replacing someone's hand-written style guide is not something to do on a
  // half-remembered version of it, so the caller has to have read it first and
  // send the whole document back. Refusing here is cheaper than an apology.
  if (existed && args.overwrite !== true) {
    throw new Error(
      "A style guide already exists at " + file.fsName + ". Read it with get_house_style, " +
      "merge your changes into the full document, and call again with overwrite: true."
    );
  }

  file.encoding = "UTF-8";
  if (!file.open("w")) throw new Error("Could not open " + file.fsName + " for writing");
  try {
    if (!file.write(content)) throw new Error("Write failed for " + file.fsName);
  } finally {
    file.close();
  }

  return {
    ok: true,
    path: file.fsName,
    bytes: content.length,
    created: !existed,
    replaced: existed
  };
});
