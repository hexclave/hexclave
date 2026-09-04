import http from "node:http";
import { URL } from "node:url";
import * as ELKModule from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { PiledriverObject } from "../piledriver/index.js";
import { createExampleFungibleLedgerDatabase } from "./example-schema.js";
import type { BulldozerDatabaseTableDescriptor } from "./index.js";

type StudioRuntime = Awaited<ReturnType<typeof createRuntime>>;
type ElkInstance = {
  layout(graph: ElkNode): Promise<ElkNode>,
};
type ElkConstructor = new () => ElkInstance;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT_SUFFIX = "40";
const GRAPH_NODE_WIDTH = 260;
const GRAPH_NODE_HEIGHT = 126;
const GRAPH_LEVEL_GAP_Y = 230;
const GRAPH_COLUMN_GAP_X = 320;
const GRAPH_SCENE_MARGIN = 40;
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const htmlHeaders = { "content-type": "text/html; charset=utf-8" };
const Elk = ((ELKModule as { default?: unknown }).default ?? ELKModule) as ElkConstructor;
const elk = new Elk();

// Every dev service derives its port from NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX so that several dev
// environments can run side by side (the dev launchpad lists Bulldozer Studio at suffix 40).
// Read it lazily: the env files are only loaded by the entrypoint, which may run after this
// module is evaluated.
function defaultPort() {
  return Number(`${process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX ?? "81"}${DEFAULT_PORT_SUFFIX}`);
}

async function collect<T>(iterable: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

async function createRuntime() {
  const db = await createExampleFungibleLedgerDatabase();
  return { db };
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : null;
}

function sendJson(response: http.ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, jsonHeaders);
  response.end(JSON.stringify(value));
}

function sendError(response: http.ServerResponse, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  sendJson(response, { error: message }, 500);
}

function parseGroupKey(raw: string | null): PiledriverObject {
  if (raw === null || raw === "") return null;
  return JSON.parse(raw) as PiledriverObject;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected JSON object body");
  return value as Record<string, unknown>;
}

async function tableGroups(runtime: StudioRuntime, tableId: string) {
  const snapshot = (await runtime.db.getSnapshot()).snapshot;
  return await collect(snapshot.listGroups({ tableId, range: {} }));
}

async function tableRows(runtime: StudioRuntime, tableId: string, groupKey: PiledriverObject, limit: number) {
  const snapshot = (await runtime.db.getSnapshot()).snapshot;
  return await collect(snapshot.listRowsInGroup({ tableId, groupKey, range: { limit } }));
}

function tableDescriptor(runtime: StudioRuntime, tableId: string) {
  const table = runtime.db.listTables().find(table => table.tableId === tableId);
  if (!table) throw new Error(`Unknown table ${tableId}`);
  return table;
}

function defaultMutableTableId(runtime: StudioRuntime) {
  const table = runtime.db.listTables().find(table => table.supportsSetRow);
  if (!table) throw new Error("No mutable table is available");
  return table.tableId;
}

function studioTableSnapshot(table: BulldozerDatabaseTableDescriptor) {
  const debugMetadata = table.debugMetadata ?? {};
  const name = typeof debugMetadata.name === "string" ? debugMetadata.name : table.tableId;
  const operator = typeof debugMetadata.operator === "string" ? debugMetadata.operator : "unknown";
  return {
    id: table.tableId,
    name,
    tableId: table.tableId,
    operator,
    dependencies: Object.values(table.inputTableIds),
    debugArgs: debugMetadata,
    supportsSetRow: table.supportsSetRow,
    supportsDeleteRow: table.supportsDeleteRow,
    initialized: true,
  };
}

async function tableDetails(runtime: StudioRuntime, tableId: string) {
  const table = studioTableSnapshot(tableDescriptor(runtime, tableId));
  const groups = await Promise.all((await tableGroups(runtime, tableId)).map(async group => ({
    groupKey: group.groupKey,
    rows: await tableRows(runtime, tableId, group.groupKey, 500),
  })));
  return {
    table,
    groups,
    totalRows: groups.reduce((sum, group) => sum + group.rows.length, 0),
  };
}

type StudioTableSnapshot = ReturnType<typeof studioTableSnapshot>;

async function computeStudioLayout(tables: StudioTableSnapshot[]): Promise<null | {
  positions: Record<string, { x: number, y: number }>,
  sceneWidth: number,
  sceneHeight: number,
}> {
  try {
    const layout = await elk.layout({
      id: "bulldozer-studio",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.padding": `[top=${GRAPH_SCENE_MARGIN},left=${GRAPH_SCENE_MARGIN},bottom=${GRAPH_SCENE_MARGIN},right=${GRAPH_SCENE_MARGIN}]`,
        "elk.spacing.nodeNode": String(Math.floor(GRAPH_COLUMN_GAP_X / 2)),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(Math.floor(GRAPH_LEVEL_GAP_Y / 2)),
        "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.layered.thoroughness": "40",
      },
      children: tables.map(table => ({
        id: table.id,
        width: GRAPH_NODE_WIDTH,
        height: GRAPH_NODE_HEIGHT,
      })),
      edges: tables.flatMap(table => table.dependencies.map((dependencyId, index) => ({
        id: `${dependencyId}->${table.id}:${index}`,
        sources: [dependencyId],
        targets: [table.id],
      }))),
    });

    const positions: Record<string, { x: number, y: number }> = {};
    for (const child of layout.children ?? []) {
      if (typeof child.id !== "string") continue;
      positions[child.id] = {
        x: Number(child.x ?? 0),
        y: Number(child.y ?? 0),
      };
    }

    return {
      positions,
      sceneWidth: Number(layout.width ?? 900),
      sceneHeight: Number(layout.height ?? 600),
    };
  } catch {
    return null;
  }
}

async function schemaPayload(runtime: StudioRuntime) {
  const descriptors = runtime.db.listTables();
  const tables = descriptors.map(table => studioTableSnapshot(table));
  const categoryTableIds = new Map<string, string[]>();
  for (const descriptor of descriptors) {
    const category = descriptor.debugMetadata?.category;
    const categories = Array.isArray(category) ? category : [category ?? "uncategorized"];
    for (const item of categories) {
      if (typeof item !== "string" || item.length === 0) continue;
      categoryTableIds.set(item, [...categoryTableIds.get(item) ?? [], descriptor.tableId]);
    }
  }
  const categoryColors = ["rgba(53, 199, 105, 0.08)", "rgba(102, 163, 255, 0.08)", "rgba(247, 185, 85, 0.10)", "rgba(255, 95, 86, 0.08)"];
  return {
    currentSchemaName: "example",
    tables,
    layout: await computeStudioLayout(tables),
    categories: [...categoryTableIds.entries()].map(([label, tableIds], index) => ({ id: label, label, color: categoryColors[index % categoryColors.length], tableIds })),
    storedTableId: descriptors.find(table => table.supportsSetRow)?.tableId ?? null,
  };
}

async function handleApi(runtime: StudioRuntime, request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
  const tableActionMatch = url.pathname.match(/^\/api\/table\/([^/]+)\/([^/]+)$/);
  const tableDetailsMatch = url.pathname.match(/^\/api\/table\/([^/]+)\/details$/);
  if (request.method === "GET" && url.pathname === "/api/schemas") {
    sendJson(response, { current: "example", available: ["example"] });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/schema") {
    sendJson(response, await schemaPayload(runtime));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/piledriver/debug") {
    sendJson(response, await runtime.db.debugPiledriverSnapshot?.() ?? { roots: [], heap: [] });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/low-level/debug") {
    sendJson(response, await runtime.db.debugLowLevelSnapshot?.() ?? { stores: {}, dumps: {} });
    return;
  }
  if (request.method === "GET" && tableDetailsMatch) {
    sendJson(response, await tableDetails(runtime, decodeURIComponent(tableDetailsMatch[1])));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/groups") {
    sendJson(response, { groups: await tableGroups(runtime, url.searchParams.get("tableId") ?? defaultMutableTableId(runtime)) });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/rows") {
    const tableId = url.searchParams.get("tableId") ?? defaultMutableTableId(runtime);
    const groupKey = parseGroupKey(url.searchParams.get("groupKey"));
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 100)));
    sendJson(response, { rows: await tableRows(runtime, tableId, groupKey, limit) });
    return;
  }
  if (request.method === "POST" && tableActionMatch) {
    const tableId = decodeURIComponent(tableActionMatch[1]);
    const action = tableActionMatch[2];
    if (!tableDescriptor(runtime, tableId).supportsSetRow) throw new Error(`Table ${tableId} is not mutable`);
    const body = requireRecord(await readJsonBody(request));
    const rowIdentifier = String(body.rowIdentifier ?? "");
    if (!rowIdentifier) throw new Error("rowIdentifier is required");
    await runtime.db.withSnapshotConsistent(async snapshot => {
      if (action === "set-row") {
        return await snapshot.setOrDeleteRow({ tableId, rowIdentifier, newRowData: body.rowData as PiledriverObject });
      } else if (action === "delete-row") {
        return await snapshot.setOrDeleteRow({ tableId, rowIdentifier, newRowData: undefined });
      } else {
        throw new Error(`Unknown table action ${action}`);
      }
    });
    sendJson(response, { ok: true, metrics: { durationMs: 0, statementCount: 1, logicalStatementCount: 1, executableStatementCount: 1, rowChangeDiagnostics: [] } });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/rows") {
    const body = requireRecord(await readJsonBody(request));
    const rowIdentifier = String(body.rowIdentifier ?? "");
    if (!rowIdentifier) throw new Error("rowIdentifier is required");
    const rowData = body.rowData as PiledriverObject;
    await runtime.db.withSnapshotConsistent(async snapshot => await snapshot.setOrDeleteRow({ tableId: defaultMutableTableId(runtime), rowIdentifier, newRowData: rowData }));
    sendJson(response, { ok: true });
    return;
  }
  if (request.method === "DELETE" && url.pathname === "/api/rows") {
    const rowIdentifier = url.searchParams.get("rowIdentifier");
    if (!rowIdentifier) throw new Error("rowIdentifier is required");
    await runtime.db.withSnapshotConsistent(async snapshot => await snapshot.setOrDeleteRow({ tableId: defaultMutableTableId(runtime), rowIdentifier, newRowData: undefined }));
    sendJson(response, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/tick") {
    const body = requireRecord(await readJsonBody(request));
    const now = new Date(String(body.now ?? ""));
    if (!Number.isFinite(now.getTime())) throw new Error("Valid now timestamp is required");
    await runtime.db.withSnapshotConsistent(async snapshot => await snapshot.tick(now));
    sendJson(response, { ok: true, now: now.toISOString() });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/timefold/debug") {
    const details = await Promise.all(runtime.db.listTables()
      .filter(table => table.supportsTick)
      .map(async table => ({ table: studioTableSnapshot(table), details: await tableDetails(runtime, table.tableId) })));
    sendJson(response, { tickableTables: details, note: "Current Bulldozer keeps the timefold queue inside each table snapshot; due processing is exposed through snapshot.tick(now)." });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/tables/init-all") {
    const fresh = await createRuntime();
    runtime.db = fresh.db;
    sendJson(response, { ok: true, initialized: runtime.db.listTables().map(table => table.tableId) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/reset") {
    const fresh = await createRuntime();
    runtime.db = fresh.db;
    sendJson(response, { ok: true });
    return;
  }
  sendJson(response, { error: "Not found" }, 404);
}

const page = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bulldozer Studio</title>
  <style>
    :root { --bg:#111; --bg-alt:#171717; --panel:#1f1f1f; --line:#343434; --grid:rgba(220,220,220,.08); --text:#f2f2f2; --muted:#b0b0b0; --accent:#66a3ff; --filter:#f7b955; --danger:#ff5f56; --ok:#35c769; --mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace; }
    body[data-theme="light"] { --bg:#f5f5f5; --bg-alt:#ececec; --panel:#fff; --line:#cfcfcf; --grid:rgba(0,0,0,.08); --text:#111; --muted:#555; --accent:#245ee9; --filter:#b06b00; --danger:#d72638; --ok:#118a3e; }
    * { box-sizing:border-box; border-radius:0!important; }
    html,body { height:100%; }
    body { margin:0; overflow:hidden; background:var(--bg); color:var(--text); font-family:"Segoe UI",Inter,sans-serif; }
    .app { display:grid; grid-template-rows:52px 1fr; height:100vh; }
    .toolbar { border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; padding:0 10px; background:var(--bg-alt); gap:10px; }
    .toolbar-left,.toolbar-right,.row,.node-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
    .title { font-weight:700; letter-spacing:.02em; margin-right:10px; white-space:nowrap; }
    .layout { display:grid; grid-template-columns:minmax(580px,58%) 1fr; min-height:0; }
    .graph-pane { border-right:1px solid var(--line); min-height:0; display:grid; }
    .details-pane { overflow:auto; padding:10px; min-height:0; }
    .graph-shell { position:relative; overflow:hidden; min-height:0; cursor:grab; background-image:linear-gradient(to right,var(--grid) 1px,transparent 1px),linear-gradient(to bottom,var(--grid) 1px,transparent 1px); background-size:24px 24px; border-top:1px solid var(--line); }
    .graph-shell.dragging { cursor:grabbing; }
    .graph-scene,.graph-edges,.graph-nodes { position:absolute; left:0; top:0; }
    .graph-scene { transform-origin:0 0; will-change:transform; }
    .graph-edges { pointer-events:none; overflow:visible; }
    .node { position:absolute; width:260px; min-height:126px; border:1px solid var(--line); background:var(--panel); padding:8px; display:grid; grid-template-rows:auto auto 1fr auto; gap:6px; cursor:grab; user-select:none; }
    .node:hover,.node.active { border-color:var(--accent); }
    .node.active { box-shadow:inset 0 0 0 1px var(--accent); }
    .node.dragging { cursor:grabbing; z-index:4; box-shadow:0 10px 28px rgba(0,0,0,.22),inset 0 0 0 1px var(--accent); }
    .node-type { font:800 28px/1 var(--mono); text-transform:uppercase; letter-spacing:.04em; color:var(--accent); }
    .node-type.stored { color:var(--ok); } .node-type.filter { color:var(--filter); } .node-type.timefold { color:color-mix(in srgb,var(--filter) 60%,var(--danger)); } .node-type.leftfold,.node-type.leftjoin { color:color-mix(in srgb,var(--accent) 65%,var(--ok)); } .node-type.reduce,.node-type.compact { color:color-mix(in srgb,var(--accent) 65%,var(--danger)); }
    .node-name { font-size:13px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .node-meta,.muted { color:var(--muted); }
    .node-meta { font:11px var(--mono); }
    .mono { font-family:var(--mono); }
    .btn,select,input,textarea { border:1px solid var(--line); background:var(--panel); color:var(--text); padding:6px 10px; font-size:12px; }
    .btn { cursor:pointer; line-height:1.1; } .btn:hover,.btn.active { border-color:var(--accent); } .btn.active { box-shadow:inset 0 0 0 1px var(--accent); } .btn.icon { width:30px; min-width:30px; padding:5px; text-align:center; } .btn.good { border-color:color-mix(in srgb,var(--ok) 40%,var(--line)); } .btn.bad { border-color:color-mix(in srgb,var(--danger) 40%,var(--line)); }
    .status-pill { font:11px var(--mono); border:1px solid var(--line); padding:3px 6px; color:var(--muted); max-width:360px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .detail-head { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:10px; }
    .detail-title { font-size:16px; font-weight:700; }
    .detail-section { border:1px solid var(--line); margin-bottom:10px; padding:8px; background:var(--panel); }
    .kv { display:grid; grid-template-columns:150px minmax(0,1fr); gap:6px 8px; font-size:12px; align-items:start; }
    .kv-key { color:var(--muted); }
    pre { margin:0; white-space:pre-wrap; word-break:break-word; border:1px solid var(--line); background:var(--bg-alt); padding:8px; font:12px var(--mono); }
    input,textarea,select { background:var(--bg-alt); font-family:var(--mono); }
    textarea { width:100%; min-height:120px; resize:vertical; }
    table { width:100%; border-collapse:collapse; font-size:12px; }
    th,td { border:1px solid var(--line); padding:5px 6px; text-align:left; vertical-align:top; }
    th,summary { background:var(--bg-alt); }
    details { border:1px solid var(--line); margin-bottom:8px; background:var(--panel); }
    summary { cursor:pointer; padding:6px 7px; border-bottom:1px solid var(--line); font:12px var(--mono); }
    .category-box { border:1px solid color-mix(in srgb,var(--line) 60%,transparent); pointer-events:none; }
    dialog { border:1px solid var(--line); background:var(--panel); color:var(--text); width:min(760px,90vw); max-height:75vh; padding:0; }
    dialog::backdrop { background:rgba(0,0,0,.45); }
    .dialog-content { padding:10px; display:grid; gap:8px; }
    .dialog-title { font-weight:700; color:var(--danger); }
    .debug-summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:8px; margin-bottom:10px; }
    .debug-card { border:1px solid var(--line); background:var(--panel); padding:8px; display:grid; gap:4px; }
    .debug-card-label { color:var(--muted); font:11px var(--mono); text-transform:uppercase; letter-spacing:.04em; }
    .debug-card-value { font-size:22px; font-weight:800; }
    .debug-card-sub { color:var(--muted); font:11px var(--mono); }
    .debug-section-title { display:flex; justify-content:space-between; gap:8px; align-items:center; }
    .debug-entry { border:1px solid var(--line); background:var(--bg-alt); margin:8px 0; }
    .debug-entry-head { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:8px; align-items:center; padding:6px 7px; border-bottom:1px solid var(--line); }
    .debug-entry-key { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .debug-pill { border:1px solid var(--line); padding:2px 6px; font:11px var(--mono); color:var(--muted); white-space:nowrap; }
    .debug-value { padding:8px; display:grid; gap:8px; }
    .debug-value-label { color:var(--muted); font:11px var(--mono); text-transform:uppercase; letter-spacing:.04em; }
    .debug-empty { color:var(--muted); border:1px dashed var(--line); padding:8px; background:var(--bg-alt); }
  </style>
</head>
<body data-theme="dark">
  <div class="app">
    <header class="toolbar">
      <div class="toolbar-left">
        <div class="title">Bulldozer Studio</div>
        <button id="modeTablesBtn" class="btn active">Tables</button>
        <button id="modeTimefoldBtn" class="btn">Timefold</button>
        <button id="modePiledriverBtn" class="btn">Piledriver</button>
        <button id="modeLowLevelBtn" class="btn">Low-level</button>
        <select id="schemaSelect" class="btn" title="Switch schema"></select>
        <button id="toggleIntermediatesBtn" class="btn">Intermediates</button>
        <button id="initAllBtn" class="btn good">Reset sample</button>
        <button id="refreshBtn" class="btn icon" title="Refresh schema and selected table">R</button>
        <button id="fitBtn" class="btn icon" title="Fit graph to viewport">F</button>
        <button id="themeBtn" class="btn icon" title="Toggle light/dark theme">T</button>
      </div>
      <div class="toolbar-right"><div class="status-pill mono" id="statusText">ready</div></div>
    </header>
    <main class="layout">
      <section class="graph-pane"><div id="graphShell" class="graph-shell"><div id="graphScene" class="graph-scene"><svg id="graphEdges" class="graph-edges"></svg><div id="graphNodes" class="graph-nodes"></div></div></div></section>
      <section class="details-pane" id="detailsPane"></section>
    </main>
  </div>
  <dialog id="errorDialog"><div class="dialog-content"><div class="dialog-title">Action failed</div><pre id="errorText"></pre><div class="row"><button id="errorCloseBtn" class="btn">Close</button></div></div></dialog>
  <script>
    const NODE_WIDTH=${GRAPH_NODE_WIDTH},NODE_HEIGHT=${GRAPH_NODE_HEIGHT},LEVEL_GAP_Y=${GRAPH_LEVEL_GAP_Y},COLUMN_GAP_X=${GRAPH_COLUMN_GAP_X},SCENE_MARGIN=${GRAPH_SCENE_MARGIN};
    const INTERMEDIATE_OPERATORS=new Set(["map","filter","flatmap"]);
    const state={mode:"table",schema:null,selectedTableId:null,selectedTableDetails:null,timefoldDebug:null,piledriverDebug:null,lowLevelDebug:null,showIntermediates:true,graphLayout:null,viewport:{x:24,y:24,scale:1},manualNodePositions:JSON.parse(localStorage.getItem("bulldozer-studio-node-positions-v2")||"{}"),dragging:{active:false}};
    const graphShell=document.getElementById("graphShell"),graphScene=document.getElementById("graphScene"),graphEdges=document.getElementById("graphEdges"),graphNodes=document.getElementById("graphNodes"),detailsPane=document.getElementById("detailsPane"),statusText=document.getElementById("statusText"),errorDialog=document.getElementById("errorDialog"),errorText=document.getElementById("errorText"),schemaSelect=document.getElementById("schemaSelect");
    function setStatus(text){statusText.textContent=text} function prettyJson(value){return JSON.stringify(value,null,2)} function compareStrings(a,b){a=String(a);b=String(b);return a<b?-1:a>b?1:0}
    function showError(error){errorText.textContent=error&&error.stack?error.stack:String(error);if(errorDialog.open)errorDialog.close();errorDialog.showModal()}
    async function fetchJson(path,init={}){const response=await fetch(path,{headers:{"content-type":"application/json"},...init});const body=await response.json().catch(()=>({}));if(!response.ok||body.error)throw new Error(body.error||response.statusText);return body}
    async function runUiAction(label,fn){try{setStatus(label+"...");await fn();setStatus("ready")}catch(error){setStatus("failed");showError(error)}}
    function escapeHtml(value){return String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;")}
    function cssClassToken(value){return String(value).toLowerCase().replace(/[^a-z0-9_-]/g,"-")}
    function shortKey(value){const text=String(value);return text.length<=34?text:text.slice(0,16)+"..."+text.slice(-12)}
    function formatBytes(value){const n=Number(value);if(!Number.isFinite(n))return "n/a";if(n<1024)return n+" B";if(n<1024*1024)return (n/1024).toFixed(1)+" KiB";return (n/1024/1024).toFixed(1)+" MiB"}
    function debugSummary(cards){return "<div class='debug-summary'>"+cards.map(card=>"<div class='debug-card'><div class='debug-card-label'>"+escapeHtml(card.label)+"</div><div class='debug-card-value'>"+escapeHtml(card.value)+"</div>"+(card.sub?"<div class='debug-card-sub'>"+escapeHtml(card.sub)+"</div>":"")+"</div>").join("")+"</div>"}
    function debugValueBlock(label,value){return "<div><div class='debug-value-label'>"+escapeHtml(label)+"</div><pre>"+escapeHtml(typeof value==="string"?value:prettyJson(value))+"</pre></div>"}
    function entryDisplayKey(entry){return entry.keyUtf8||entry.keyHex&&"0x"+entry.keyHex||"(no key)"}
    function debugEntry(kind,entry,index,options={}){const open=options.open?" open":"";const displayKey=entryDisplayKey(entry);const title=options.title||shortKey(displayKey);const bytes=formatBytes(entry.valueByteLength);const preview=entry.valueUtf8!=null?entry.valueUtf8:entry.serializedJson!==undefined?entry.serializedJson:entry.valueBase64;return "<details class='debug-entry'"+open+"><summary class='debug-entry-head'><span class='debug-entry-key mono' title='"+escapeHtml(displayKey)+"'>"+escapeHtml(title)+"</span><span class='debug-pill'>"+escapeHtml(kind)+"</span><span class='debug-pill'>"+escapeHtml(bytes)+"</span></summary><div class='debug-value'>"+debugValueBlock("key",displayKey)+debugValueBlock(entry.valueUtf8!=null?"utf8 value":entry.serializedJson!==undefined?"serialized value":"value base64",preview)+(entry.valueBase64?debugValueBlock("value base64",entry.valueBase64):"")+"</div></details>"}
    function debugSection(title,subtitle,entries,kind){return "<details class='detail-section' open><summary><span class='debug-section-title'><span>"+escapeHtml(title)+"</span><span class='muted'>"+escapeHtml(subtitle)+"</span></span></summary>"+(entries.length?entries.map((entry,index)=>debugEntry(kind,entry,index,{open:index===0,title:entry.name||shortKey(entry.keyBase64)})).join(""):"<div class='debug-empty'>No entries.</div>")+"</details>"}
    function normalizedOperator(table){return String(table.operator||"unknown").toLowerCase()} function visibleTables(){return state.schema.tables.filter(table=>state.showIntermediates||!INTERMEDIATE_OPERATORS.has(normalizedOperator(table)))} function getNodePosition(id){const p=state.manualNodePositions[id];return p&&Number.isFinite(p.x)&&Number.isFinite(p.y)?p:null} function persistNodePositions(){localStorage.setItem("bulldozer-studio-node-positions-v2",JSON.stringify(state.manualNodePositions))}
    function computeDepth(id,map,cache,visiting){if(cache.has(id))return cache.get(id);if(visiting.has(id))return 0;visiting.add(id);const deps=map.get(id)?.dependencies||[];const depth=deps.length?1+Math.max(...deps.map(dep=>computeDepth(dep,map,cache,visiting))):0;visiting.delete(id);cache.set(id,depth);return depth}
    function avg(ids,order,fallback){const values=ids.map(id=>order.get(id)).filter(v=>v!=null);return values.length?values.reduce((a,b)=>a+b,0)/values.length:fallback}
    function layoutGraph(tables){const map=new Map(tables.map(t=>[t.id,t])),cache=new Map(),base=state.schema&&state.schema.layout&&state.schema.layout.positions?state.schema.layout:null,positions=new Map();let sceneWidth=base&&Number.isFinite(base.sceneWidth)?base.sceneWidth:900,sceneHeight=base&&Number.isFinite(base.sceneHeight)?base.sceneHeight:600;if(base){for(const t of tables){computeDepth(t.id,map,cache,new Set());const basePos=base.positions[t.id],manual=getNodePosition(t.id),x=manual?manual.x:Number(basePos?.x??SCENE_MARGIN),y=manual?manual.y:Number(basePos?.y??SCENE_MARGIN);positions.set(t.id,{x,y});sceneWidth=Math.max(sceneWidth,x+NODE_WIDTH+SCENE_MARGIN);sceneHeight=Math.max(sceneHeight,y+NODE_HEIGHT+SCENE_MARGIN)}return{positions,sceneWidth,sceneHeight,depthById:cache}}const reverse=new Map(tables.map(t=>[t.id,[]])),byDepth=new Map();for(const t of tables)for(const dep of t.dependencies||[])(reverse.get(dep)||[]).push(t.id);for(const t of tables){const d=computeDepth(t.id,map,cache,new Set());if(!byDepth.has(d))byDepth.set(d,[]);byDepth.get(d).push(t)}const depths=[...byDepth.keys()].sort((a,b)=>a-b);for(const d of depths)byDepth.get(d).sort((a,b)=>compareStrings(a.name,b.name));for(let i=0;i<5;i++){const order=new Map();for(const d of depths)(byDepth.get(d)||[]).forEach((t,j)=>order.set(t.id,j));for(const d of depths.slice(1))byDepth.get(d).sort((a,b)=>avg(a.dependencies||[],order,9999)-avg(b.dependencies||[],order,9999)||compareStrings(a.name,b.name));order.clear();for(const d of depths)(byDepth.get(d)||[]).forEach((t,j)=>order.set(t.id,j));for(const d of [...depths].reverse().slice(1))byDepth.get(d).sort((a,b)=>avg(reverse.get(a.id)||[],order,9999)-avg(reverse.get(b.id)||[],order,9999)||compareStrings(a.name,b.name))}depths.forEach((d,di)=>{const row=byDepth.get(d),total=row.length*NODE_WIDTH+Math.max(0,row.length-1)*COLUMN_GAP_X,startX=SCENE_MARGIN+Math.max(0,(900-total)/2);row.forEach((t,j)=>{const manual=getNodePosition(t.id),x=manual?manual.x:startX+j*(NODE_WIDTH+COLUMN_GAP_X),y=manual?manual.y:SCENE_MARGIN+di*LEVEL_GAP_Y;positions.set(t.id,{x,y});sceneWidth=Math.max(sceneWidth,x+NODE_WIDTH+SCENE_MARGIN);sceneHeight=Math.max(sceneHeight,y+NODE_HEIGHT+SCENE_MARGIN)})});return{positions,sceneWidth,sceneHeight,depthById:cache}}
    function updateSceneTransform(){graphScene.style.transform="translate("+state.viewport.x+"px,"+state.viewport.y+"px) scale("+state.viewport.scale+")"} function syncSceneDimensions(){const l=state.graphLayout;graphScene.style.width=l.sceneWidth+"px";graphScene.style.height=l.sceneHeight+"px";graphEdges.setAttribute("width",String(l.sceneWidth));graphEdges.setAttribute("height",String(l.sceneHeight));graphEdges.setAttribute("viewBox","0 0 "+l.sceneWidth+" "+l.sceneHeight);graphNodes.style.width=l.sceneWidth+"px";graphNodes.style.height=l.sceneHeight+"px"}
    function renderEdges(){graphEdges.innerHTML="";const defs=document.createElementNS("http://www.w3.org/2000/svg","defs"),marker=document.createElementNS("http://www.w3.org/2000/svg","marker"),markerPath=document.createElementNS("http://www.w3.org/2000/svg","path");marker.setAttribute("id","arrow");marker.setAttribute("viewBox","0 0 10 10");marker.setAttribute("refX","9");marker.setAttribute("refY","5");marker.setAttribute("markerWidth","7");marker.setAttribute("markerHeight","7");marker.setAttribute("orient","auto");markerPath.setAttribute("d","M 0 0 L 10 5 L 0 10 z");markerPath.setAttribute("fill","var(--accent)");marker.appendChild(markerPath);defs.appendChild(marker);graphEdges.appendChild(defs);const visible=new Set(visibleTables().map(t=>t.id));for(const table of visibleTables()){const to=state.graphLayout.positions.get(table.id);for(const dep of table.dependencies||[]){if(!visible.has(dep))continue;const from=state.graphLayout.positions.get(dep);if(!from||!to)continue;const sx=from.x+NODE_WIDTH/2,sy=from.y+NODE_HEIGHT,ex=to.x+NODE_WIDTH/2,ey=to.y,lane=Math.max(sy+20,(sy+ey)/2),path=document.createElementNS("http://www.w3.org/2000/svg","path");path.setAttribute("d","M "+sx+" "+sy+" C "+sx+" "+lane+", "+ex+" "+lane+", "+ex+" "+ey);path.setAttribute("fill","none");path.setAttribute("stroke","var(--accent)");path.setAttribute("stroke-width","1.7");path.setAttribute("marker-end","url(#arrow)");graphEdges.appendChild(path)}}}
    function renderCategories(){if(!Array.isArray(state.schema.categories))return;for(const cat of state.schema.categories){const ps=cat.tableIds.map(id=>state.graphLayout.positions.get(id)).filter(Boolean);if(!ps.length)continue;const minX=Math.min(...ps.map(p=>p.x))-24,minY=Math.min(...ps.map(p=>p.y))-24,maxX=Math.max(...ps.map(p=>p.x+NODE_WIDTH))+24,maxY=Math.max(...ps.map(p=>p.y+NODE_HEIGHT))+24,box=document.createElement("div");box.className="category-box";box.style.position="absolute";box.style.left=minX+"px";box.style.top=minY+"px";box.style.width=maxX-minX+"px";box.style.height=maxY-minY+"px";box.style.background=cat.color||"rgba(128,128,128,.08)";box.style.zIndex="0";box.innerHTML="<div style='position:absolute;inset:0;display:grid;place-items:center;font-size:34px;font-weight:800;opacity:.16;text-align:center'>"+escapeHtml(cat.label||"")+"</div>";graphNodes.appendChild(box)}}
    function renderGraph(){graphNodes.innerHTML="";state.graphLayout=layoutGraph(state.schema.tables);syncSceneDimensions();renderCategories();for(const table of visibleTables()){const pos=state.graphLayout.positions.get(table.id),op=normalizedOperator(table),node=document.createElement("div");node.className="node"+(state.selectedTableId===table.id?" active":"");node.dataset.tableId=table.id;node.style.left=pos.x+"px";node.style.top=pos.y+"px";node.innerHTML="<div class='node-type "+cssClassToken(op)+"'>"+escapeHtml(table.operator)+"</div><div class='node-name mono'>"+escapeHtml(table.name)+"</div><div class='node-meta'>initialized | deps: "+escapeHtml(table.dependencies.length)+" | rows: "+escapeHtml(table.totalRows??"?")+"</div><div class='node-actions'><div class='row'>"+(table.supportsSetRow?"<span class='muted mono'>mutable</span>":"")+"</div><button class='btn icon' title='Select table'>S</button></div>";node.onclick=()=>runUiAction("load table",async()=>{setMode("table");await selectTable(table.id)});node.onmousedown=e=>{if(e.target.closest("button"))return;e.preventDefault();state.dragging={active:true,kind:"node",nodeId:table.id,startX:e.clientX,startY:e.clientY,nodeStartX:pos.x,nodeStartY:pos.y,moved:false};node.classList.add("dragging");graphShell.classList.add("dragging")};graphNodes.appendChild(node)}renderEdges();updateSceneTransform()}
    function fitGraphToView(){if(!state.graphLayout)return;const r=graphShell.getBoundingClientRect(),scale=Math.max(.25,Math.min(1.5,Math.min((r.width-72)/state.graphLayout.sceneWidth,(r.height-72)/state.graphLayout.sceneHeight)));state.viewport.scale=scale;state.viewport.x=(r.width-state.graphLayout.sceneWidth*scale)/2;state.viewport.y=(r.height-state.graphLayout.sceneHeight*scale)/2;updateSceneTransform()}
    function setMode(mode){state.mode=mode;document.getElementById("modeTablesBtn").classList.toggle("active",mode==="table");document.getElementById("modeTimefoldBtn").classList.toggle("active",mode==="timefold");document.getElementById("modePiledriverBtn").classList.toggle("active",mode==="piledriver");document.getElementById("modeLowLevelBtn").classList.toggle("active",mode==="lowlevel");renderDetails()}
    async function loadSchema(){const schemas=await fetchJson("/api/schemas");schemaSelect.innerHTML=schemas.available.map(name=>"<option "+(name===schemas.current?"selected":"")+">"+escapeHtml(name)+"</option>").join("");state.schema=await fetchJson("/api/schema");if(!state.selectedTableId)state.selectedTableId=state.schema.tables[0]?.id;renderGraph();if(state.selectedTableId)await selectTable(state.selectedTableId);fitGraphToView()}
    async function selectTable(id){state.selectedTableId=id;state.selectedTableDetails=await fetchJson("/api/table/"+encodeURIComponent(id)+"/details");const t=state.schema.tables.find(t=>t.id===id);if(t)t.totalRows=state.selectedTableDetails.totalRows;renderGraph();renderDetails()}
    async function tableAction(id,action,payload){const res=await fetchJson("/api/table/"+encodeURIComponent(id)+"/"+action,{method:"POST",body:JSON.stringify(payload||{})});await loadSchema();return res}
    function renderDetails(){if(state.mode==="timefold")return renderTimefoldDetails();if(state.mode==="piledriver")return renderPiledriverDetails();if(state.mode==="lowlevel")return renderLowLevelDetails();return renderTableDetails()}
    function renderTableDetails(){const d=state.selectedTableDetails;if(!d){detailsPane.textContent="No table selected.";return}const t=d.table;detailsPane.innerHTML="";const head=document.createElement("div");head.className="detail-head";head.innerHTML="<div><div class='detail-title'>"+escapeHtml(t.name)+"</div><div class='muted mono'>"+escapeHtml(t.tableId)+"</div></div><button class='btn icon' id='refreshDetailsBtn' title='Refresh selected table'>R</button>";detailsPane.appendChild(head);document.getElementById("refreshDetailsBtn").onclick=()=>runUiAction("refresh table",async()=>selectTable(t.id));const meta=document.createElement("div");meta.className="detail-section kv";meta.innerHTML="<div class='kv-key'>operator</div><div class='mono'>"+escapeHtml(t.operator)+"</div><div class='kv-key'>dependencies</div><pre>"+escapeHtml(prettyJson(t.dependencies))+"</pre><div class='kv-key'>rows</div><div class='mono'>"+escapeHtml(d.totalRows)+"</div><div class='kv-key'>debug args</div><pre>"+escapeHtml(prettyJson(t.debugArgs))+"</pre>";detailsPane.appendChild(meta);if(t.supportsSetRow)renderMutationPanel(t);const rowsSection=document.createElement("div");rowsSection.className="detail-section";rowsSection.innerHTML="<div class='muted mono' style='margin-bottom:6px;'>rows grouped by groupKey</div>";for(const g of d.groups){const w=document.createElement("details");w.open=d.groups.length<=8;const s=document.createElement("summary");s.textContent="group="+prettyJson(g.groupKey)+" ("+g.rows.length+" rows)";w.appendChild(s);const table=document.createElement("table");table.innerHTML="<thead><tr><th>rowIdentifier</th><th>rowSortKey</th><th>rowData</th></tr></thead>";const tbody=document.createElement("tbody");for(const row of g.rows){const tr=document.createElement("tr");tr.innerHTML="<td class='mono'>"+escapeHtml(prettyJson(row.rowIdentifier))+"</td><td class='mono'>"+escapeHtml(prettyJson(row.rowSortKey))+"</td><td><pre>"+escapeHtml(prettyJson(row.rowData))+"</pre></td>";tbody.appendChild(tr)}table.appendChild(tbody);w.appendChild(table);rowsSection.appendChild(w)}detailsPane.appendChild(rowsSection)}
    function renderMutationPanel(t){const p=document.createElement("div");p.className="detail-section";const sample=t.debugArgs&&t.debugArgs.sampleRow?t.debugArgs.sampleRow:{};p.innerHTML="<div class='muted mono' style='margin-bottom:6px;'>mutations</div><input id='setRowId' placeholder='rowIdentifier' value='entry-new' /><textarea id='setRowData'>"+escapeHtml(prettyJson(sample))+"</textarea><input id='deleteRowId' placeholder='rowIdentifier to delete' /><div class='row'><button id='setRowBtn' class='btn good'>set row</button><button id='deleteRowBtn' class='btn bad'>delete row</button></div>";detailsPane.appendChild(p);document.getElementById("setRowBtn").onclick=()=>runUiAction("set row",async()=>tableAction(t.id,"set-row",{rowIdentifier:document.getElementById("setRowId").value.trim(),rowData:JSON.parse(document.getElementById("setRowData").value)}));document.getElementById("deleteRowBtn").onclick=()=>runUiAction("delete row",async()=>tableAction(t.id,"delete-row",{rowIdentifier:document.getElementById("deleteRowId").value.trim()}))}
    async function loadTimefoldDebug(){state.timefoldDebug=await fetchJson("/api/timefold/debug");renderDetails()}
    function renderTimefoldDetails(){detailsPane.innerHTML="";const head=document.createElement("div");head.className="detail-head";head.innerHTML="<div><div class='detail-title'>Timefold queue debug</div><div class='muted mono'>Queues live inside table snapshots in current Bulldozer.</div></div><button id='refreshTimefoldBtn' class='btn icon' title='Refresh timefold debug'>R</button>";detailsPane.appendChild(head);document.getElementById("refreshTimefoldBtn").onclick=()=>runUiAction("refresh timefold",loadTimefoldDebug);const controls=document.createElement("div");controls.className="detail-section";controls.innerHTML="<div class='muted mono' style='margin-bottom:6px;'>tick</div><div class='row'><input id='tickAt' type='datetime-local' value='2026-01-01T00:15' /><button id='tickBtn' class='btn good' title='Run snapshot.tick(now) for all tickable tables'>tick all</button></div>";detailsPane.appendChild(controls);document.getElementById("tickBtn").onclick=()=>runUiAction("tick",async()=>{const now=new Date(document.getElementById("tickAt").value);await fetchJson("/api/tick",{method:"POST",body:JSON.stringify({now:now.toISOString()})});await loadSchema();await loadTimefoldDebug()});const body=document.createElement("div");body.className="detail-section";body.innerHTML=state.timefoldDebug?"<pre>"+escapeHtml(prettyJson(state.timefoldDebug))+"</pre>":"<div class='muted'>No timefold snapshot loaded.</div>";detailsPane.appendChild(body)}
    async function loadPiledriverDebug(){state.piledriverDebug=await fetchJson("/api/piledriver/debug");renderDetails()}
    function renderPiledriverDetails(){detailsPane.innerHTML="";const head=document.createElement("div");head.className="detail-head";head.innerHTML="<div><div class='detail-title'>Piledriver view</div><div class='muted mono'>Serialized roots and heap objects underneath Bulldozer.</div></div><button id='refreshPiledriverBtn' class='btn icon' title='Refresh Piledriver view'>R</button>";detailsPane.appendChild(head);document.getElementById("refreshPiledriverBtn").onclick=()=>runUiAction("refresh piledriver",loadPiledriverDebug);const snapshot=state.piledriverDebug;if(!snapshot){const empty=document.createElement("div");empty.className="debug-empty";empty.textContent="No Piledriver snapshot loaded.";detailsPane.appendChild(empty);return}const roots=Array.isArray(snapshot.roots)?snapshot.roots:[],heap=Array.isArray(snapshot.heap)?snapshot.heap:[],totalBytes=roots.concat(heap).reduce((sum,entry)=>sum+Number(entry.valueByteLength||0),0);const body=document.createElement("div");body.innerHTML=debugSummary([{label:"roots",value:roots.length,sub:"named root objects"},{label:"heap",value:heap.length,sub:"deduplicated objects"},{label:"bytes",value:formatBytes(totalBytes),sub:"serialized payloads"}])+debugSection("Root objects","Piledriver root store",roots.map(entry=>({...entry,name:"root "+shortKey(entryDisplayKey(entry))})),"root")+debugSection("Heap objects","Piledriver immutable heap dump",heap,"heap");detailsPane.appendChild(body)}
    async function loadLowLevelDebug(){state.lowLevelDebug=await fetchJson("/api/low-level/debug");renderDetails()}
    function renderLowLevelDetails(){detailsPane.innerHTML="";const head=document.createElement("div");head.className="detail-head";head.innerHTML="<div><div class='detail-title'>Low-level database view</div><div class='muted mono'>Raw KV stores and dumps as base64 keys and buffers.</div></div><button id='refreshLowLevelBtn' class='btn icon' title='Refresh low-level view'>R</button>";detailsPane.appendChild(head);document.getElementById("refreshLowLevelBtn").onclick=()=>runUiAction("refresh low-level",loadLowLevelDebug);const snapshot=state.lowLevelDebug;if(!snapshot){const empty=document.createElement("div");empty.className="debug-empty";empty.textContent="No low-level snapshot loaded.";detailsPane.appendChild(empty);return}const stores=snapshot.stores&&typeof snapshot.stores==="object"?snapshot.stores:{},dumps=snapshot.dumps&&typeof snapshot.dumps==="object"?snapshot.dumps:{},storeEntries=Object.entries(stores),dumpEntries=Object.entries(dumps),allEntries=storeEntries.concat(dumpEntries).flatMap(([_,entries])=>Array.isArray(entries)?entries:[]),totalBytes=allEntries.reduce((sum,entry)=>sum+Number(entry.valueByteLength||0),0);const body=document.createElement("div");body.innerHTML=debugSummary([{label:"stores",value:storeEntries.length,sub:"mutable KV stores"},{label:"dumps",value:dumpEntries.length,sub:"append-only KV dumps"},{label:"entries",value:allEntries.length,sub:"raw records"},{label:"bytes",value:formatBytes(totalBytes),sub:"stored buffers"}])+storeEntries.map(([storeId,entries])=>debugSection("Store: "+storeId,(Array.isArray(entries)?entries.length:0)+" entries",Array.isArray(entries)?entries:[],"store")).join("")+dumpEntries.map(([dumpId,entries])=>debugSection("Dump: "+dumpId,(Array.isArray(entries)?entries.length:0)+" entries",Array.isArray(entries)?entries:[],"dump")).join("");detailsPane.appendChild(body)}
    document.getElementById("errorCloseBtn").onclick=()=>errorDialog.close();document.getElementById("modeTablesBtn").onclick=()=>setMode("table");document.getElementById("modeTimefoldBtn").onclick=()=>runUiAction("load timefold",async()=>{setMode("timefold");await loadTimefoldDebug()});document.getElementById("modePiledriverBtn").onclick=()=>runUiAction("load piledriver",async()=>{setMode("piledriver");await loadPiledriverDebug()});document.getElementById("modeLowLevelBtn").onclick=()=>runUiAction("load low-level",async()=>{setMode("lowlevel");await loadLowLevelDebug()});document.getElementById("toggleIntermediatesBtn").onclick=()=>{state.showIntermediates=!state.showIntermediates;renderGraph()};document.getElementById("initAllBtn").onclick=()=>runUiAction("reset sample",async()=>{await fetchJson("/api/tables/init-all",{method:"POST"});await loadSchema()});document.getElementById("refreshBtn").onclick=()=>runUiAction("refresh",loadSchema);document.getElementById("fitBtn").onclick=fitGraphToView;document.getElementById("themeBtn").onclick=()=>{document.body.dataset.theme=document.body.dataset.theme==="dark"?"light":"dark"};
    graphShell.addEventListener("mousedown",e=>{if(e.target!==graphShell)return;state.dragging={active:true,kind:"scene",startX:e.clientX,startY:e.clientY,startOffsetX:state.viewport.x,startOffsetY:state.viewport.y};graphShell.classList.add("dragging")});
    window.addEventListener("mousemove",e=>{if(!state.dragging.active)return;if(state.dragging.kind==="scene"){state.viewport.x=state.dragging.startOffsetX+e.clientX-state.dragging.startX;state.viewport.y=state.dragging.startOffsetY+e.clientY-state.dragging.startY;updateSceneTransform()}else if(state.dragging.kind==="node"){const dx=(e.clientX-state.dragging.startX)/state.viewport.scale,dy=(e.clientY-state.dragging.startY)/state.viewport.scale;state.manualNodePositions[state.dragging.nodeId]={x:state.dragging.nodeStartX+dx,y:state.dragging.nodeStartY+dy};state.dragging.moved=true;renderGraph()}});
    window.addEventListener("mouseup",()=>{if(state.dragging.kind==="node"&&state.dragging.moved)persistNodePositions();state.dragging.active=false;graphShell.classList.remove("dragging");for(const n of graphNodes.querySelectorAll(".node.dragging"))n.classList.remove("dragging")});
    graphShell.addEventListener("wheel",e=>{e.preventDefault();state.viewport.scale=Math.max(.2,Math.min(2.4,state.viewport.scale*(e.deltaY<0?1.08:.92)));updateSceneTransform()},{passive:false});
    loadSchema().catch(showError);
  </script>
</body>
</html>`;

export async function runBulldozerStudio(options: { host?: string, port?: number } = {}) {
  let runtime = await createRuntime();
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? defaultPort();
  const server = http.createServer((request, response) => {
    const handleRequest = async () => {
      const url = new URL(request.url ?? "/", `http://${host}:${port}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(runtime, request, response, url);
        return;
      }
      response.writeHead(200, htmlHeaders);
      response.end(page);
    };
    handleRequest().then(undefined, (error) => {
      sendError(response, error);
    });
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.log(`Bulldozer Studio listening at http://${host}:${port}`);
  return {
    url: `http://${host}:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
