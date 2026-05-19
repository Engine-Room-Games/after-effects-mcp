// markers.jsx — comp markers and layer markers.

function __mkMarkerValue(args) {
  var mv = new MarkerValue(args.comment || "");
  if (args.duration !== undefined) mv.duration = args.duration;
  if (args.label !== undefined) mv.label = args.label;
  if (args.chapter) mv.chapter = args.chapter;
  if (args.url) mv.url = args.url;
  if (args.frameTarget) mv.frameTarget = args.frameTarget;
  return mv;
}

OPS.add_marker = function (args) {
  var c = getCompById(args.compId);
  var mv = __mkMarkerValue(args);
  if (args.layerId !== undefined && args.layerId !== null) {
    var l = getLayerById(c, args.layerId);
    var mProp = l.property("Marker");
    mProp.setValueAtTime(args.time, mv);
  } else {
    var compMarkers = c.markerProperty;
    compMarkers.setValueAtTime(args.time, mv);
  }
  return { ok: true };
};

OPS.remove_marker = function (args) {
  var c = getCompById(args.compId);
  if (args.layerId !== undefined && args.layerId !== null) {
    var l = getLayerById(c, args.layerId);
    l.property("Marker").removeKey(args.markerIndex);
  } else {
    c.markerProperty.removeKey(args.markerIndex);
  }
  return { ok: true };
};
