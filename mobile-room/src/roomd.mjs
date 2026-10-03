// roomd — Mobile OpenRig room gateway
// Binds ONLY to: a local interface (default loopback) + one private network
// interface of your choice (e.g. a Tailscale/VPN interface IP). Never exposes
// the OpenRig daemon, which should itself stay loopback-only.
// Zero npm dependencies: Node 22 built-ins (http, node:sqlite, child_process).
//
// Configuration precedence: environment variables > roomd.config.json > defaults.
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────
const env = process.env;
const CFG_PATH = env.ROOM_CONFIG || path.join(__dirname, "..", "roomd.config.json");
const cfgDefault = {
  daemon: {
    host: env.OPENRIG_HOST || "127.0.0.1",
    port: Number(env.OPENRIG_PORT || 31455),
  },
  bind: {
    // "local" listener for same-machine access (keep loopback by default)
    local: { host: env.ROOM_HOST || "127.0.0.1", port: Number(env.ROOM_PORT || 8800) },
    // optional private-network listener (e.g. your Tailscale interface IP)
    private: env.ROOM_PRIVATE_HOST ? { host: env.ROOM_PRIVATE_HOST, port: Number(env.ROOM_PRIVATE_PORT || env.ROOM_PORT || 8800) } : null,
  },
  mcp: { host: env.MCP_HOST || "127.0.0.1", port: Number(env.MCP_PORT || 8810) },
  rig: env.OPENRIG_RIG || "first-project",
  agents: [
    { session: "dev-owner@first-project", name: "Codex · owner", short: "dev-owner", kind: "codex", avatar: "🧑‍💻" },
    { session: "dev-check@first-project", name: "Codex · checker", short: "dev-check", kind: "codex", avatar: "🔍" },
  ],
  humans: [{ id: env.ROOM_HUMAN_ID || "you", name: env.ROOM_HUMAN_NAME || "You", avatar: "🧑" }],
  hermes: { name: "Hermes", avatar: "🪽", session: "openrig-room", timeoutMs: 600000, workdir: env.HERMES_WORKDIR || null },
  nexus: { name: "Nexus", avatar: "🌐" },
  limits: { maxAutoHandoffDepth: 2, transcriptPollActiveMs: 4000, transcriptPollIdleMs: 15000, dedupeWindowMs: 600000 },
};
let cfg;
try { cfg = { ...cfgDefault, ...JSON.parse(fs.readFileSync(CFG_PATH, "utf8")) }; }
catch { cfg = cfgDefault; }

const DAEMON = `http://${cfg.daemon.host}:${cfg.daemon.port}`;
const RIG_NAME = cfg.rig;
const MAX_DEPTH = cfg.limits.maxAutoHandoffDepth;
const HUMAN = cfg.humans[0];

// ── State store (task chains, dedupe, seat transcript snapshots) ───────────
// Runtime state lives OUTSIDE the source tree by default (override: ROOM_STATE_DB).
const STATE_DB = env.ROOM_STATE_DB || path.join(__dirname, "..", ".state", "room-state.db");
fs.mkdirSync(path.dirname(STATE_DB), { recursive: true });
const db = new DatabaseSync(STATE_DB);
db.exec(`CREATE TABLE IF NOT EXISTS chains (
  task_id TEXT PRIMARY KEY, parent_task TEXT, origin TEXT, depth INTEGER,
  created_at INTEGER, status TEXT, note TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS sent_hashes (
  h TEXT PRIMARY KEY, created_at INTEGER)`);
db.exec(`CREATE TABLE IF NOT EXISTS seat_seen (
  session TEXT PRIMARY KEY, content TEXT, updated_at INTEGER)`);
const now = () => Date.now();
const wipeOld = (table, ms) => db.prepare(`DELETE FROM ${table} WHERE created_at < ?`).run(now() - ms);
const seenHash = (s) => { wipeOld("sent_hashes", cfg.limits.dedupeWindowMs); try { db.prepare("INSERT INTO sent_hashes VALUES (?,?)").run(s, now()); return true; } catch { return false; } };

// ── OpenRig daemon client (public HTTP API) ─────────────────────────────────
let RIG_ID = null;
async function refreshRigId() {
  const rigs = await jget("/api/rigs/summary");
  const hit = (Array.isArray(rigs) ? rigs : rigs?.rigs || []).find(r => r.name === RIG_NAME);
  if (hit) RIG_ID = hit.rigId ?? hit.id;
  return RIG_ID;
}
async function jget(p) {
  const res = await fetch(DAEMON + p, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${p} -> ${res.status}`);
  return res.json();
}
async function chatSend(sender, body) {
  if (!RIG_ID) await refreshRigId();
  const res = await fetch(`${DAEMON}/api/rigs/${RIG_ID}/chat/send`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, body }), signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`chat/send ${res.status}: ${await res.text()}`);
  return res.json();
}
async function chatHistory(afterId, limit = 200) {
  if (!RIG_ID) await refreshRigId();
  const q = new URLSearchParams({ limit: String(limit) });
  if (afterId) q.set("after", afterId);
  return jget(`/api/rigs/${RIG_ID}/chat/history?${q}`);
}
async function nodes() {
  if (!RIG_ID) await refreshRigId();
  return jget(`/api/rigs/${RIG_ID}/nodes`);
}
async function rigSend(session, text) {
  // CLI send: reliable two-step delivery incl. interactive-prompt guard.
  const { stdout } = await execFileP("rig", ["send", session, text], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}
async function seatTranscript(session) {
  const { stdout } = await execFileP("rig", ["transcript", session, "--json", "--tail", "60"], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}

// ── Speaker registry / friendly rendering ───────────────────────────────────
const SPEAKERS = new Map();
for (const a of cfg.agents) SPEAKERS.set(a.session, a);
for (const h of cfg.humans) SPEAKERS.set(h.id, h);
SPEAKERS.set("hermes", cfg.hermes);
SPEAKERS.set("nexus", cfg.nexus);
SPEAKERS.set("system", { id: "system", name: "Room", avatar: "🛰️", short: "room" });
function speakerFor(sender) {
  if (SPEAKERS.has(sender)) return SPEAKERS.get(sender);
  const a = cfg.agents.find(x => x.session === sender || x.session.split("@")[0] === sender);
  return a || { id: sender, name: sender, avatar: "🤖", short: sender.split("@")[0] };
}

// ── Hermes bridge ───────────────────────────────────────────────────────────
const hermesQ = [];
let hermesBusy = false;
function hermesEnqueue(job) { hermesQ.push(job); hermesDrain(); }
async function hermesDrain() {
  if (hermesBusy) return;
  const job = hermesQ.shift();
  if (!job) return;
  hermesBusy = true;
  try {
    const tmp = path.join(os_tmp(), `room-hermes-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(tmp, job.text, { mode: 0o600 });
    const args = ["chat", "--query-file", tmp, "--oneshot", "--continue", cfg.hermes.session,
      "--create-if-missing", "--in", job.workdir || cfg.hermes.workdir || os_homedir(),
      "-Q", "--format", "stream-json"];
    await new Promise((resolve) => {
      const p = spawn("hermes", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
      let out = "", err = "";
      const timer = setTimeout(() => { p.kill("SIGKILL"); job.done("⏱ Hermes timed out.", "error"); resolve(); }, cfg.hermes.timeoutMs);
      p.stdout.on("data", d => out += d);
      p.stderr.on("data", d => err += d);
      p.on("close", () => { clearTimeout(timer); fs.rmSync(tmp, { force: true });
        let result = null, init = null;
        for (const line of out.split("\n")) {
          if (!line.trim().startsWith("{")) continue;
          try { const j = JSON.parse(line); if (j.type === "init") init = j; if (j.type === "result") result = j; } catch {}
        }
        if (result && typeof result.text === "string") job.done(result.text, "ok");
        else job.done(`⚠️ Hermes returned no result.${err ? " stderr: " + err.slice(0, 300) : ""}`, "error");
        resolve();
      });
    });
  } catch (e) { job.done(`⚠️ Hermes bridge error: ${e.message}`, "error"); }
  hermesBusy = false;
  hermesDrain();
}
import os from "node:os";
const os_tmp = () => os.tmpdir();
const os_homedir = () => os.homedir();

// ── Seat watcher: envelope-anchored reply extraction ────────────────────────
// rig send types a "From: … To: … Sent: … --- body --- ↩ Reply: …" envelope
// into the seat's terminal. The agent's answer is what renders after that
// envelope, before the next Tip:/prompt chrome. We capture the whole pane
// and extract the block after the LATEST envelope.
const seatState = new Map(); // session -> { lastSentStamp, lastReplyHash }
function lastEnvelopeStamp(content) {
  const stamps = content.match(/Sent: \d\d-\d\d \d\d:\d\dZ/g) || [];
  return stamps.length ? stamps[stamps.length - 1] : null;
}
function extractReply(content) {
  const idx = content.lastIndexOf("From: <unknown sender>");
  if (idx === -1) return null;
  const after = content.slice(idx);
  const m = after.match(/---\s*\n([\s\S]*?)\n\s*---/); // the sent body
  const sentBody = m ? m[1].trim() : null;
  const replyIdx = after.indexOf("↩ Reply:");
  if (replyIdx === -1) return null;
  const lines = after.slice(replyIdx).split("\n").slice(1);
  const keep = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) { if (keep.length) break; continue; }
    if (/^› Ask Codex to do anything/.test(l)) break;
    if (/^Tip:/.test(t)) break;
    if (/GPT-6-Astra default/.test(l)) break;
    if (/\? for shortcuts/.test(l)) break;
    if (/^\d+:\d\d\s*(AM|PM)$/.test(t)) continue;
    keep.push(l.trim());
    if (keep.join("\n").length > 2000) break;
  }
  const reply = keep.join("\n").trim();
  return reply ? { reply, sentBody } : null;
}
async function pollSeat(agent, status) {
  const st = seatState.get(agent.session) || { lastSentStamp: null, lastReplyHash: "" };
  let t;
  try {
    const { stdout } = await execFileP("rig", ["transcript", agent.session, "--json", "--tail", "200"], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    t = JSON.parse(stdout);
  } catch { return; }
  const content = t.content ?? "";
  const stamp = lastEnvelopeStamp(content);
  if (!stamp || stamp === st.lastSentStamp) { seatState.set(agent.session, st); return; }
  const ex = extractReply(content);
  if (!ex || !ex.reply) { seatState.set(agent.session, st); return; }
  const h = crypto.createHash("sha256").update(agent.session + "|" + stamp + "|" + ex.reply).digest("hex");
  if (h === st.lastReplyHash) { seatState.set(agent.session, st); return; }
  const act = status?.activity;
  if (act === "working" || act === "running") { seatState.set(agent.session, st); return; } // mid-turn; sample again later
  seatState.set(agent.session, { lastSentStamp: stamp, lastReplyHash: h });
  const body = ex.reply.length > 2000 ? "…" + ex.reply.slice(-1990) : ex.reply;
  const h2 = crypto.createHash("sha256").update(agent.session + "|" + stamp + "|" + body).digest("hex");
  if (!seenHash(h2)) return; // duplicate — already posted
  await chatSend(agent.session, body);
}

// ── Status watcher ──────────────────────────────────────────────────────────
let lastStatusJson = "";
let helloSent = false;
const agentRuntime = new Map(); // session -> {activity, status, model, lastActivity}
async function statusTick() {
  try {
    const ns = await nodes();
    for (const agent of cfg.agents) {
      const n = (Array.isArray(ns) ? ns : ns.nodes || []).find(x => x.canonicalSessionName === agent.session);
      const cur = {
        status: n?.sessionStatus ?? "unknown",
        startupStatus: n?.startupStatus ?? "unknown",
        activity: n?.agentActivity?.state ?? "unknown",
        model: n?.model ?? null,
        lastActivity: n?.lastActivityAt ?? null,
        reason: n?.recoveryGuidance ?? n?.attentionReason ?? null,
        work: n?.hasAssignedWork ?? false,
      };
      agentRuntime.set(agent.session, cur);
      await pollSeat(agent, cur);
    }
    const hermesState = { activity: hermesBusy ? "working" : (hermesQ.length ? "queued" : "idle"), status: "running" };
    agentRuntime.set("hermes", hermesState);
    agentRuntime.set("nexus", { activity: "idle", status: mcpServing ? "running" : "standby" });
    const snap = JSON.stringify(Object.fromEntries(agentRuntime));
    if (snap !== lastStatusJson) { lastStatusJson = snap; broadcast({ type: "status", agents: await agentsPayload() }); }
    else if (!helloSent) { helloSent = true; broadcast({ type: "hello", rig: RIG_NAME, human: { id: HUMAN.id, name: HUMAN.name, avatar: HUMAN.avatar } }); }
  } catch (e) { /* daemon briefly unreachable — retry next tick */ }
}
function classify(rt) {
  if (!rt) return "offline";
  if (rt.status === "running" && (rt.activity === "working" || rt.activity === "running" || rt.activity === "queued")) return "working";
  if (rt.status === "running" && rt.activity === "idle") return "online";
  if (rt.status === "running") return "waiting";
  if (rt.startupStatus === "failed" || rt.status === "failed") return "error";
  return "offline";
}
async function agentsPayload() {
  const out = [];
  for (const a of cfg.agents) {
    const rt = agentRuntime.get(a.session);
    out.push({ id: a.session, name: a.name, short: a.short, avatar: a.avatar, kind: a.kind,
      state: classify(rt), model: rt?.model, lastActivity: rt?.lastActivity, hasWork: rt?.work, detail: rt?.reason });
  }
  const h = agentRuntime.get("hermes");
  out.push({ id: "hermes", name: cfg.hermes.name, short: "hermes", avatar: cfg.hermes.avatar, kind: "hermes",
    state: classify({ status: h?.status ?? "unknown", activity: h?.activity }), detail: hermesQ.length ? `${hermesQ.length} queued` : null });
  out.push({ id: "nexus", name: cfg.nexus.name, short: "nexus", avatar: cfg.nexus.avatar, kind: "nexus",
    state: "unavailable",
    detail: "connector unavailable — no ChatGPT connection (dev-mode connectors need Business/Enterprise)",
    connectable: true });
  return out;
}

// ── Task chains / routing / loop protection ─────────────────────────────────
const ulid = () => crypto.randomUUID();
const TARGET_RE = /(?:^|\s)@?(dev-owner|dev-check|codex|hermes|nexus|all)\b/i;
function resolveTarget(text, explicit) {
  const t = (explicit || "").toLowerCase().trim();
  if (t === "all" || t === "room") return { mode: "room" };
  if (t) {
    if (t === "hermes") return { mode: "hermes" };
  if (t === "nexus") return { mode: "none", note: "Nexus — connector unavailable. Not routed to any agent (no ChatGPT connection exists; dev-mode connectors need Business/Enterprise)." };
    const ag = cfg.agents.find(a => a.short === t || a.session === t || a.session.split("@")[0] === t);
    if (ag) return { mode: "seat", agent: ag };
    return { mode: "room" };
  }
  const m = text.match(TARGET_RE);
  if (!m) return { mode: "room" };
  const word = m[1].toLowerCase();
  if (word === "all") return { mode: "room" };
  if (word === "hermes") return { mode: "hermes" };
  if (word === "nexus") return { mode: "none", note: "Nexus — connector unavailable. Not routed to any agent (no ChatGPT connection exists; dev-mode connectors need Business/Enterprise)." };
  if (word === "codex") return { mode: "seat", agent: cfg.agents[0] };
  const ag = cfg.agents.find(a => a.short === word);
  if (ag) return { mode: "seat", agent: ag };
  return { mode: "room" };
}
async function routeMessage({ sender, text, to, parentTask, depth }) {
  // Loop protection: auto-handoffs (agent→agent) capped at MAX_DEPTH.
  const taskId = ulid();
  db.prepare("INSERT OR REPLACE INTO chains VALUES (?,?,?,?,?,?,?)")
    .run(taskId, parentTask ?? null, sender, depth ?? 0, now(), "routed", null);
  const target = resolveTarget(text, to);
  if ((depth ?? 0) >= MAX_DEPTH && sender !== HUMAN.id && sender !== "nexus") {
    await chatSend("system", `⛔ Handoff depth limit reached (${MAX_DEPTH}). Not auto-routing further — reply to the human to continue.`);
    return taskId;
  }
  if (target.mode === "hermes") {
    hermesEnqueue({
      text, workdir: cfg.hermes.workdir,
      done: async (replyText, kind) => {
        await chatSend("hermes", replyText);
        if (kind === "error") await chatSend("system", `⚠ Hermes job for this request ended with an error.`);
      },
    });
  } else if (target.mode === "seat") {
    try { await rigSend(target.agent.session, text); }
    catch (e) { await chatSend("system", `⚠ Could not deliver to ${target.agent.short}: ${String(e.message || e).slice(0, 200)}`); }
  } else if (target.mode === "none") {
    // Deliberately unroutable (e.g. Nexus with no live connector): the message is
    // recorded in the room transcript but reaches NO agent. No fallback, no
    // mislabeling — the note explains why.
  } else {
    // room broadcast → all seats AND hermes (chat-addressed messages are the
    // room's shared conversation; Hermes participates as a room member).
    for (const a of cfg.agents) {
      try { await rigSend(a.session, text); } catch (e) { await chatSend("system", `⚠ Could not deliver to ${a.short}: ${String(e.message || e).slice(0, 200)}`); }
    }
    hermesEnqueue({
      text: `[Room message from ${sender === HUMAN.id ? HUMAN.name : sender}] ${text}`,
      workdir: cfg.hermes.workdir,
      done: async (replyText, kind) => {
        await chatSend("hermes", replyText);
        if (kind === "error") await chatSend("system", `⚠ Hermes job for this request ended with an error.`);
      },
    });
  }
  if (target.note) await chatSend("system", target.note);
  return taskId;
}

// ── SSE fan-out to browsers ─────────────────────────────────────────────────
const clients = new Set();
function broadcast(obj) { const s = JSON.stringify(obj); for (const c of clients) c.write(`data: ${s}\n\n`); }

// ── Chat watch proxy (daemon SSE → broadcast) ───────────────────────────────
async function chatWatchLoop() {
  for (;;) {
    try {
      if (!RIG_ID) { await refreshRigId(); if (!RIG_ID) throw new Error("rig not found"); }
      const res = await fetch(`${DAEMON}/api/rigs/${RIG_ID}/chat/watch`, { signal: AbortSignal.timeout(3600_000) });
      if (!res.ok || !res.body) throw new Error(`watch ${res.status}`);
      broadcast({ type: "hello", rig: RIG_NAME, human: { id: HUMAN.id, name: HUMAN.name, avatar: HUMAN.avatar } });
      const dec = new TextDecoder();
      for await (const chunk of res.body) {
        const text = typeof chunk === "string" ? chunk : dec.decode(chunk);
        const m = text.match(/^data: (.+)$/m);
        if (m) { try { broadcast({ type: "chat", message: pretty(JSON.parse(m[1])) }); } catch {} }
      }
    } catch { await new Promise(r => setTimeout(r, 3000)); }
  }
}

// ── MCP surface for Nexus (ChatGPT via Secure MCP Tunnel) ───────────────────
// Narrow, room-scoped tools only. No rig_up/rig_down — the controller may
// message the room and read it, not rewire the fleet.
let mcpServing = false;
const mcpServers = [];
function mcpReady(srv) { if (srv) { mcpServers.push(srv); } mcpServing = mcpServers.some(s => s.listening); }
const MCP_TOOLS = [
  { name: "room_read", description: "Read the OpenRig room conversation (latest messages).", input: { type: "object", properties: { limit: { type: "number", description: "Max messages (default 25)" } } } },
  { name: "room_send", description: "Send a message into the room as Nexus. Optionally address one agent via 'to' (dev-owner, dev-check, hermes, all).", input: { type: "object", properties: { text: { type: "string" }, to: { type: "string" } }, required: ["text"] } },
  { name: "agents_status", description: "List room agents and their current state (online/working/waiting/error).", input: { type: "object", properties: {} } },
  { name: "task_delegate", description: "Delegate a task to an agent and get a task id. Use for assignments that should be tracked.", input: { type: "object", properties: { text: { type: "string" }, to: { type: "string" } }, required: ["text", "to"] } },
];
async function mcpCall(name, args) {
  if (name === "room_read") {
    const want = Math.min(100, args.limit ?? 25);
    const hist = await chatHistory(null, 500);
    return hist.slice(-want).map(m => `[${m.createdAt}] ${speakerFor(m.sender).name}: ${m.body}`).join("\n") || "(empty room)";
  }
  if (name === "room_send") { await chatSend("nexus", args.text); const tid = await routeMessage({ sender: "nexus", text: args.text, to: args.to, depth: 0 }); return `sent; task ${tid}`; }
  if (name === "agents_status") { return (await agentsPayload()).map(a => `${a.name}: ${a.state}${a.detail ? " — " + a.detail : ""}`).join("\n"); }
  if (name === "task_delegate") { const tid = await routeMessage({ sender: "nexus", text: args.text, to: args.to, depth: 0 }); return `delegated; task ${tid}; watch room_read for the reply`; }
  throw new Error(`unknown tool ${name}`);
}

// ── HTTP: room web app (Tailscale-bound) + MCP (loopback-only) ──────────────
const PUBLIC = path.join(__dirname, "..", "public");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };
function serveStatic(req, res, urlPath) {
  let p = urlPath === "/" ? "/index.html" : urlPath;
  const f = path.normalize(path.join(PUBLIC, p));
  if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    res.end(data);
  });
}
function json(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
async function readBody(req) { let b = ""; for await (const c of req) b += c; try { return JSON.parse(b || "{}"); } catch { return null; } }

const seenSends = new Map(); // dup protection for human sends
async function roomHandler(req, res) {
  const u = new URL(req.url, "http://x");
  if (req.method === "GET" && u.pathname === "/api/health") return json(res, 200, { ok: true, rig: RIG_NAME });
  if (req.method === "GET" && u.pathname === "/api/hello") return json(res, 200, { rig: RIG_NAME, human: { id: HUMAN.id, name: HUMAN.name, avatar: HUMAN.avatar } });
  if (req.method === "GET" && u.pathname === "/api/agents") return json(res, 200, { agents: await agentsPayload() });
  if (req.method === "GET" && u.pathname === "/api/messages") {
    const after = u.searchParams.get("after");
    const want = Math.min(500, Number(u.searchParams.get("limit") || 200));
    let hist = await chatHistory(after, 500);   // fetch a wide window…
    if (!after) hist = hist.slice(-want);        // …then return the NEWEST slice
    return json(res, 200, { messages: hist.map(pretty) });
  }
  if (req.method === "GET" && u.pathname === "/api/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    res.write(`retry: 3000\n\n`);
    clients.add(res); res.on("close", () => clients.delete(res));
    res.write(`data: ${JSON.stringify({ type: "hello", rig: RIG_NAME, human: { id: HUMAN.id, name: HUMAN.name, avatar: HUMAN.avatar } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "status", agents: await agentsPayload() })}\n\n`);
    return;
  }
  if (req.method === "POST" && u.pathname === "/api/send") {
    const body = await readBody(req);
    if (!body || typeof body.text !== "string" || !body.text.trim()) return json(res, 400, { error: "bad_request", message: "text required" });
    if (body.text.length > 8000) return json(res, 400, { error: "too_long", message: "max 8000 chars" });
    const sender = HUMAN.id;
    const dh = crypto.createHash("sha256").update(sender + body.text).digest("hex");
    const prev = seenSends.get(dh);
    if (prev && now() - prev < 30000) return json(res, 429, { error: "duplicate", message: "identical message just sent" });
    seenSends.set(dh, now());
    for (const [k, v] of seenSends) if (now() - v > 300000) seenSends.delete(k);
    const msg = await chatSend(sender, body.text.trim());
    await routeMessage({ sender, text: body.text.trim(), to: body.to, depth: 0 });
    return json(res, 201, { message: pretty(msg) });
  }
  return serveStatic(req, res, u.pathname);
}
function pretty(m) { const sp = speakerFor(m.sender); return { ...m, speaker: { id: sp.id ?? sp.session ?? m.sender, name: sp.name, avatar: sp.avatar, short: sp.short ?? sp.name } }; }

// MCP streamable-HTTP on loopback ONLY (tunnel-client will dial it locally).
async function mcpHandler(req, res) {
  if (req.method === "POST" && req.url === "/mcp") {
    const body = await readBody(req);
    if (!body || body.jsonrpc !== "2.0") return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
    const { id, method, params } = body;
    if (method === "initialize") return json(res, 200, { jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "openrig-room", version: "0.1.0" } } });
    if (method === "notifications/initialized") { res.writeHead(204); return res.end(); }
    if (method === "tools/list") return json(res, 200, { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.input })) } });
    if (method === "tools/call") {
      try { const out = await mcpCall(params.name, params.arguments ?? {}); return json(res, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(out) }] } }); }
      catch (e) { return json(res, 200, { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String(e.message || e) }] } }); }
    }
    if (method === "ping") return json(res, 200, { jsonrpc: "2.0", id, result: {} });
    return json(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  }
  res.writeHead(404); res.end();
}

// ── Boot ────────────────────────────────────────────────────────────────────
function startServer(handler, host, port, label, retry = true) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    let attempts = 0;
    const tryBind = () => srv.listen(port, host, () => { console.log(`[roomd] ${label} listening on http://${host}:${port}`); mcpReady(srv); resolve(srv); });
    srv.on("error", (e) => {
      attempts++;
      if (retry && (e.code === "EADDRNOTAVAIL" || e.code === "EADDRINUSE") && attempts < 120) setTimeout(tryBind, 5000);
      else { console.error(`[roomd] ${label} bind failed: ${e.message}`); resolve(null); }
    });
    tryBind();
  });
}
// (mcpReady is defined near the MCP surface above)
startServer(mcpHandler, cfg.mcp.host, cfg.mcp.port, "MCP");
startServer(roomHandler, cfg.bind.local.host, cfg.bind.local.port, "room (local)");
if (cfg.bind.private) startServer(roomHandler, cfg.bind.private.host, cfg.bind.private.port, "room (private network)");
refreshRigId().then(() => console.log(`[roomd] rig ${RIG_NAME} id=${RIG_ID}`)).catch(e => console.error("[roomd] rig lookup:", e.message));
chatWatchLoop();
setInterval(statusTick, cfg.limits.transcriptPollActiveMs);
statusTick();
