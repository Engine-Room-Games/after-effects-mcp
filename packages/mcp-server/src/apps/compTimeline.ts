/**
 * The one MCP Apps view this server ships (issue #246): a comp timeline drawn
 * from the fingerprint `snapshot_comp` and `diff_comp` already gather.
 *
 * Why this view and these two tools. A comp's shape in time — which layer
 * spans which seconds, where the work area and markers sit, what is parented
 * to what, which layers carry keys — is the thing a person reads off After
 * Effects' own timeline at a glance and the thing a JSON list is worst at.
 * The fingerprint is exactly that data, and both tools fetch it anyway, so the
 * view costs After Effects nothing: no extra bridge call, no new op, no panel
 * change (the thin-panel rule). After a diff the same timeline marks what was
 * added, changed and removed, which is the verify-a-write habit the guides
 * teach, made visible to the person watching. The fingerprint records key
 * *counts*, not key times, so the rows carry count badges rather than ticks;
 * drawing ticks would mean a per-layer keyframe read on every snapshot, which
 * is the cost the fingerprint exists to avoid.
 *
 * Strictly additive. Everything here is offered only to a client that declared
 * the MCP Apps extension (`io.modelcontextprotocol/ui`) in `initialize`: the
 * tool `_meta`, the `ui://` resource in `resources/list`, and the view data on
 * the result. Any other client gets byte-for-byte today's tool list, resource
 * list and tool results. Even for a client that has it, the text content is
 * unchanged and complete; the view data rides in the result's `_meta`, which
 * the spec keeps out of the model's context.
 *
 * Self-contained by construction: the HTML inlines its script and style, loads
 * nothing over the network, and declares no CSP domains, so the host's
 * restrictive default (no connect, no external resources) applies.
 */

/** The MCP Apps extension id a client declares under `capabilities.extensions`. */
export const UI_EXTENSION = "io.modelcontextprotocol/ui";
/** The one MIME type the MCP Apps spec defines for a view. */
export const UI_MIME = "text/html;profile=mcp-app";
export const COMP_TIMELINE_URI = "ui://after-effects/comp-timeline.html";
/** Where the view's data rides on a tool result. Namespaced, per the `_meta` key rules. */
export const VIEW_DATA_KEY = "engineroom.games/compTimeline";
/** A comp with more layers than this is drawn truncated, and the view says so. */
export const MAX_VIEW_LAYERS = 500;
/** Comp markers past this many are not drawn; the view says how many. Drawn once, not per row. */
export const MAX_VIEW_MARKERS = 100;
/** Removed layers drawn as ghosts after a diff; the rest are counted. */
export const MAX_VIEW_REMOVED = 100;

/** Tools whose result the timeline can draw. */
export const APP_TOOLS: ReadonlySet<string> = new Set(["snapshot_comp", "diff_comp"]);

/**
 * True when the client said it can render MCP Apps views of this MIME type.
 * The SDK keeps `extensions` on the client capabilities as sent.
 */
export function clientSupportsApps(caps: unknown): boolean {
  const ext = (caps as { extensions?: Record<string, unknown> } | undefined)?.extensions?.[UI_EXTENSION] as
    | { mimeTypes?: unknown }
    | undefined;
  if (!ext || typeof ext !== "object") return false;
  // The spec makes mimeTypes required: a client that did not name this type
  // has not said it can render it.
  return Array.isArray(ext.mimeTypes) && ext.mimeTypes.includes(UI_MIME);
}

/**
 * The tool `_meta` linking a tool to the view, in the spec's nested form. The
 * flat `ui/resourceUri` key was the draft's and the stable spec (2026-01-26)
 * deprecates it, so it is not sent.
 */
export function toolUiMeta(name: string): Record<string, unknown> | undefined {
  if (!APP_TOOLS.has(name)) return undefined;
  return { ui: { resourceUri: COMP_TIMELINE_URI } };
}

export const COMP_TIMELINE_RESOURCE = {
  uri: COMP_TIMELINE_URI,
  name: "comp-timeline",
  title: "Comp timeline",
  description:
    "Interactive view for snapshot_comp and diff_comp: the comp's layers as in/out bars with work area, " +
    "markers, parenting and keyframe counts, and after a diff what was added, changed and removed.",
  mimeType: UI_MIME,
};

/* eslint-disable @typescript-eslint/no-explicit-any -- fingerprints are JSON from ExtendScript */
type Fp = Record<string, any>;

/**
 * The fingerprint as drawn: at most MAX_VIEW_LAYERS layers and MAX_VIEW_MARKERS
 * comp markers, each remainder counted so the view can say what it left out.
 * The stored fingerprint is never mutated.
 */
function bound(fp: Fp): { fingerprint: Fp; layersOmitted: number; markersOmitted: number } {
  const layers: Fp[] = Array.isArray(fp.layers) ? fp.layers : [];
  const markers: unknown[] = Array.isArray(fp.markers) ? fp.markers : [];
  return {
    fingerprint: { ...fp, layers: layers.slice(0, MAX_VIEW_LAYERS), markers: markers.slice(0, MAX_VIEW_MARKERS) },
    layersOmitted: Math.max(0, layers.length - MAX_VIEW_LAYERS),
    markersOmitted: Math.max(0, markers.length - MAX_VIEW_MARKERS),
  };
}

/** What the view draws for a snapshot. */
export function snapshotViewData(fingerprint: Fp): Record<string, unknown> {
  return { kind: "snapshot", ...bound(fingerprint) };
}

/**
 * What the view draws for a diff: the fresh fingerprint, plus the diff keyed by
 * layer id. A removed layer is gone from the fresh fingerprint, so its old
 * timing comes from the previous one, to draw as a ghost.
 */
export function diffViewData(before: Fp, after: Fp, diff: Record<string, any>): Record<string, unknown> {
  const drawn = bound(after);
  // Only changes to layers the view draws travel with it, so the payload is
  // bounded by the same cap as the layers; the rest are counted.
  const shown = new Set<unknown>((drawn.fingerprint.layers as Fp[]).map((l) => l.id));
  let changesOmitted = 0;
  const keep = (list: Fp[] | undefined): Fp[] => {
    const all = list ?? [];
    const kept = all.filter((x) => shown.has(x.id));
    changesOmitted += all.length - kept.length;
    return kept;
  };
  const old = new Map<unknown, Fp>();
  for (const l of (before.layers as Fp[]) ?? []) old.set(l.id, l);
  const allRemoved: Fp[] = diff.removed ?? [];
  changesOmitted += Math.max(0, allRemoved.length - MAX_VIEW_REMOVED);
  const removed = allRemoved.slice(0, MAX_VIEW_REMOVED).map((r) => {
    const l = old.get(r.id) ?? {};
    return { id: r.id, name: r.name, type: r.type, inPoint: l.inPoint, outPoint: l.outPoint };
  });
  return {
    kind: "diff",
    ...drawn,
    diff: {
      summary: diff.summary,
      changeCount: diff.changeCount,
      added: keep(diff.added).map((a) => a.id),
      changed: Object.fromEntries(keep(diff.changed).map((c) => [c.id, c.changes])),
      reordered: keep(diff.reordered).map((r) => r.id),
      removed,
      changesOmitted,
      comp: diff.comp ?? null,
    },
  };
}

/** `resources/read` for the view. `prefersBorder` asks the host for a framed card. */
export function readCompTimeline() {
  return {
    contents: [
      {
        uri: COMP_TIMELINE_URI,
        mimeType: UI_MIME,
        text: COMP_TIMELINE_HTML,
        _meta: { ui: { prefersBorder: true } },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The view. Plain HTML + one inline script; no framework, no network. The
// host↔view protocol is JSON-RPC 2.0 over postMessage to window.parent, as the
// MCP Apps spec (2026-01-26) defines it: ui/initialize, then
// ui/notifications/initialized; the host sends ui/notifications/tool-input and
// ui/notifications/tool-result; the view reports ui/notifications/size-changed.
// Every string from the project goes in through textContent, never innerHTML:
// layer names are the user's data.
// ---------------------------------------------------------------------------
export const COMP_TIMELINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comp timeline</title>
<style>
:root{--namew:clamp(110px,32%,220px);--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#e3e3e8;--bar:#5b7bd5;--wa:rgba(91,123,213,.10);--add:#2e9d5b;--chg:#c98a12;--del:#c94040;--mk:#8a5cd1;
font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light}
:root[data-theme=dark]{--bg:#1e1e20;--fg:#ececf0;--muted:#9a9aa2;--line:#35353a;--bar:#7d97e8;--wa:rgba(125,151,232,.14);--add:#4cc27f;--chg:#e0a93a;--del:#e06666;--mk:#b08ae8;color-scheme:dark}
body{margin:0;padding:12px;background:var(--bg);color:var(--fg)}
h1{font-size:14px;margin:0 0 2px}.meta{color:var(--muted);margin-bottom:8px}
.summary{margin:0 0 8px;padding:6px 8px;border-left:3px solid var(--chg);background:var(--wa)}
.tools{display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap}
.tools input[type=search]{flex:1;min-width:120px;padding:3px 6px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg)}
.grid{position:relative;display:grid;grid-template-columns:var(--namew) 1fr;align-items:center}
.over{position:absolute;top:0;bottom:0;left:var(--namew);right:0;pointer-events:none}
.ruler,.row{display:contents}
.name{padding:3px 6px 3px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid var(--line)}
.name .idx{color:var(--muted);display:inline-block;min-width:2.2em}
.name .par{color:var(--muted)}
.track{position:relative;height:22px;border-bottom:1px solid var(--line)}
.wa{position:absolute;top:0;bottom:0;background:var(--wa)}
.bar{position:absolute;top:5px;height:12px;border-radius:3px;background:var(--bar);opacity:.85}
.off .bar{opacity:.3}.off .name{color:var(--muted)}
.mk{position:absolute;top:0;bottom:0;width:0;border-left:1px dashed var(--mk)}
.badges{position:absolute;right:2px;top:3px;display:flex;gap:3px}
.b{font-size:10px;padding:0 4px;border-radius:3px;background:var(--line);color:var(--fg)}
.add .bar{background:var(--add)}.chg .bar{background:var(--chg)}.del .bar{background:var(--del);opacity:.35}
.add .name{color:var(--add)}.chg .name{color:var(--chg)}.del .name{color:var(--del);text-decoration:line-through}
.sel .name,.rel .name{font-weight:600}.sel .track{outline:2px solid var(--bar);outline-offset:-2px}
.tick{position:absolute;top:0;font-size:10px;color:var(--muted);border-left:1px solid var(--line);padding-left:2px;height:100%}
.ruler .track{height:16px}
.detail{margin-top:8px;color:var(--muted);min-height:1.4em;white-space:pre-wrap}
.empty{color:var(--muted)}
</style></head>
<body><div id="app" class="empty">Waiting for a snapshot_comp or diff_comp result…</div>
<script>
(function(){
"use strict";
var KEY="${VIEW_DATA_KEY}";
var nextId=1,pending={},data=null,selected=null,filter="",onlyChanged=false;
function send(msg){window.parent.postMessage(msg,"*");}
function request(method,params){var id=nextId++;send({jsonrpc:"2.0",id:id,method:method,params:params||{}});return new Promise(function(res,rej){pending[id]={res:res,rej:rej};});}
function notify(method,params){send({jsonrpc:"2.0",method:method,params:params||{}});}
function theme(ctx){if(!ctx)return;if(ctx.theme)document.documentElement.setAttribute("data-theme",ctx.theme);}
if(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)document.documentElement.setAttribute("data-theme","dark");
window.addEventListener("message",function(ev){
  if(ev.source!==window.parent)return;
  var m=ev.data;if(!m||m.jsonrpc!=="2.0")return;
  if(m.id!==undefined&&!m.method&&pending[m.id]){var p=pending[m.id];delete pending[m.id];if(m.error)p.rej(m.error);else p.res(m.result);return;}
  if(m.method==="ui/notifications/tool-result"){fromResult(m.params);return;}
  if(m.method==="ui/notifications/host-context-changed"){theme(m.params);return;}
  if(m.method&&m.id!==undefined){send({jsonrpc:"2.0",id:m.id,result:{}});}
});
// Prefer the view data in _meta; fall back to a fingerprint the agent asked
// for in the text (includeFingerprint) when a host does not forward _meta.
function fromResult(r){
  if(!r)return;
  var d=r._meta&&r._meta[KEY];
  if(!d&&r.content){for(var i=0;i<r.content.length;i++){var c=r.content[i];if(c&&c.type==="text"){try{var j=JSON.parse(c.text);if(j&&j.fingerprint){d={kind:j.changeCount!==undefined?"diff-text":"snapshot",fingerprint:j.fingerprint};var mk=d.fingerprint.markers;if(mk&&mk.length>${MAX_VIEW_MARKERS}){d.markersOmitted=mk.length-${MAX_VIEW_MARKERS};d.fingerprint.markers=mk.slice(0,${MAX_VIEW_MARKERS});}break;}}catch(e){}}}}
  if(!d){var a=el("div","empty");a.textContent=r.isError?"The call failed; nothing to draw.":"This host did not pass the timeline data to the view, so there is nothing to draw.";mount(a);return;}
  data=d;selected=null;render();
}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function mount(node){var app=document.getElementById("app");app.className="";app.replaceChildren(node);size();}
function num(n,d){return typeof n==="number"&&isFinite(n)?n:d;}
function secs(t){return (Math.round(t*100)/100)+"s";}
function render(){
  var fp=data.fingerprint||{},layers=fp.layers||[],dur=Math.max(num(fp.duration,0),0.001);
  var diff=data.diff||null,added={},changed={},reordered={};
  if(diff){(diff.added||[]).forEach(function(i){added[i]=1;});changed=diff.changed||{};(diff.reordered||[]).forEach(function(i){reordered[i]=1;});}
  var byId={};layers.forEach(function(l){byId[l.id]=l;});
  var root=el("div");
  root.appendChild(el("h1",null,fp.name||"Comp"));
  root.appendChild(el("div","meta",[fp.width+"\\u00d7"+fp.height,secs(num(fp.duration,0)),num(fp.frameRate,0)+" fps",(fp.numLayers!==undefined?fp.numLayers:layers.length)+" layers",data.kind==="snapshot"?"snapshot":"after the diff"].join(" \\u00b7 ")));
  if(diff&&diff.summary)root.appendChild(el("p","summary",diff.summary));
  var left=[];
  if(data.layersOmitted)left.push("the first "+layers.length+" layers are drawn; "+data.layersOmitted+" more are not");
  if(data.markersOmitted)left.push((fp.markers||[]).length+" comp markers are drawn; "+data.markersOmitted+" more are not");
  if(diff&&diff.changesOmitted)left.push(diff.changesOmitted+" added, changed or removed layers are not marked here (the text result lists them)");
  if(data.kind==="diff-text")left.push("drawn from the text result, so changes are not marked");
  if(left.length)root.appendChild(el("p","summary","Left out: "+left.join("; ")+"."));
  var tools=el("div","tools"),q=el("input");q.type="search";q.placeholder="Filter layers by name";q.value=filter;
  q.addEventListener("input",function(){filter=q.value;render();var n=document.querySelector("input[type=search]");if(n){n.focus();n.setSelectionRange(n.value.length,n.value.length);}});
  tools.appendChild(q);
  if(diff){var lab=el("label"),cb=el("input");cb.type="checkbox";cb.checked=onlyChanged;cb.addEventListener("change",function(){onlyChanged=cb.checked;render();});lab.appendChild(cb);lab.appendChild(document.createTextNode(" changes only"));tools.appendChild(lab);}
  root.appendChild(tools);
  var grid=el("div","grid");
  function pct(t){return Math.max(0,Math.min(100,num(t,0)/dur*100));}
  // Work area and markers are drawn once, in one overlay across every row.
  var over=el("div","over");
  var ws=num(fp.workAreaStart,0),wd=num(fp.workAreaDuration,dur);
  if(ws>0||wd<dur){var wa=el("div","wa");wa.style.left=pct(ws)+"%";wa.style.width=(pct(ws+wd)-pct(ws))+"%";over.appendChild(wa);}
  (fp.markers||[]).forEach(function(s){var t=parseFloat(String(s).split("|")[0]);if(isFinite(t)){var m=el("div","mk");m.style.left=pct(t)+"%";over.appendChild(m);}});
  var ruler=el("div","ruler");ruler.appendChild(el("div","name",""));var rt=el("div","track");
  var step=dur<=2?0.5:dur<=10?1:dur<=30?5:dur<=120?10:60;
  for(var t=0;t<dur-step*0.3;t+=step){var k=el("div","tick",secs(t));k.style.left=pct(t)+"%";rt.appendChild(k);}
  ruler.appendChild(rt);grid.appendChild(ruler);
  var related={};if(selected!==null){var s=byId[selected];if(s&&s.parentId!==null)related[s.parentId]=1;layers.forEach(function(l){if(l.parentId===selected)related[l.id]=1;});}
  function row(l,cls,info){
    var r=el("div","row "+cls);
    var n=el("div","name");n.appendChild(el("span","idx",l.index!==undefined?String(l.index):"\\u2013"));n.appendChild(document.createTextNode(l.name||("Layer "+l.id)));
    if(l.parentId!==null&&l.parentId!==undefined&&byId[l.parentId])n.appendChild(el("span","par"," \\u21b3 "+byId[l.parentId].name));
    n.title=info;r.appendChild(n);
    var tr=el("div","track");
    var b=el("div","bar");var a=pct(l.inPoint),z=pct(l.outPoint);b.style.left=a+"%";b.style.width=Math.max(z-a,0.4)+"%";tr.appendChild(b);
    var bs=el("div","badges"),kc=l.keyCounts||{};
    Object.keys(kc).forEach(function(p){bs.appendChild(el("span","b",p+" "+kc[p]));});
    if(l.expressionCount)bs.appendChild(el("span","b","expr "+l.expressionCount));
    if(l.effectCount)bs.appendChild(el("span","b","fx "+l.effectCount));
    tr.appendChild(bs);tr.title=info;r.appendChild(tr);
    r.addEventListener("click",function(){selected=selected===l.id?null:l.id;render();});
    grid.appendChild(r);
  }
  function describe(l,ch){
    var lines=[(l.name||"Layer")+"  (id "+l.id+(l.type?", "+l.type:"")+")","in "+secs(num(l.inPoint,0))+"  out "+secs(num(l.outPoint,0))+(l.startTime!==undefined?"  start "+secs(num(l.startTime,0)):"")];
    if(l.enabled===false)lines.push("disabled");
    if(ch)Object.keys(ch).forEach(function(k){var v=ch[k];if(k==="keyCounts"){Object.keys(v).forEach(function(p){lines.push(p+" keys "+v[p].from+" \\u2192 "+v[p].to);});}else lines.push(k+": "+JSON.stringify(v.from)+" \\u2192 "+JSON.stringify(v.to));});
    return lines.join("\\n");
  }
  var f=filter.toLowerCase(),shown=0;
  layers.forEach(function(l){
    var isAdd=!!added[l.id],ch=changed[l.id],isChg=!!ch||!!reordered[l.id];
    if(f&&String(l.name||"").toLowerCase().indexOf(f)<0)return;
    if(onlyChanged&&!isAdd&&!isChg)return;
    var cls=(l.enabled===false?"off ":"")+(isAdd?"add ":isChg?"chg ":"")+(selected===l.id?"sel ":related[l.id]?"rel ":"");
    row(l,cls,describe(l,ch)+(isAdd?"\\nadded":"")+(reordered[l.id]?"\\nreordered":""));shown++;
  });
  if(diff)(diff.removed||[]).forEach(function(l){if(f&&String(l.name||"").toLowerCase().indexOf(f)<0)return;row({id:l.id,name:l.name,type:l.type,inPoint:l.inPoint,outPoint:l.outPoint,parentId:null},"del",describe(l)+"\\nremoved");shown++;});
  grid.insertBefore(over,grid.firstChild);root.appendChild(grid);
  if(!shown)root.appendChild(el("p","empty",layers.length?"No layer matches.":"This comp has no layers."));
  var det=el("div","detail");det.textContent=selected!==null&&byId[selected]?describe(byId[selected],changed[selected]):"Click a layer to see its timing and its parent and children; hover for details.";
  root.appendChild(det);
  mount(root);
}
// Size is reported only once the handshake is done, and measured from the
// content box (#app plus the body's padding), never from a body or document the
// host's frame has stretched — so the view can shrink as well as grow.
var ready=false,lastH=-1,lastW=-1;
function size(){
  if(!ready)return;
  var app=document.getElementById("app"),cs=getComputedStyle(document.body),r=app.getBoundingClientRect();
  var h=Math.ceil(r.height+parseFloat(cs.paddingTop)+parseFloat(cs.paddingBottom)),w=Math.ceil(app.scrollWidth+parseFloat(cs.paddingLeft)+parseFloat(cs.paddingRight));
  if(h===lastH&&w===lastW)return;lastH=h;lastW=w;
  notify("ui/notifications/size-changed",{width:w,height:h});
}
if(window.ResizeObserver)new ResizeObserver(size).observe(document.getElementById("app"));
function initialized(){notify("ui/notifications/initialized",{});ready=true;size();}
request("ui/initialize",{appInfo:{name:"after-effects-comp-timeline",version:"1"},appCapabilities:{},protocolVersion:"2026-01-26"})
  .then(function(r){theme(r&&r.hostContext);initialized();})
  .catch(function(){initialized();});
})();
</script></body></html>
`;
