// Pollinations Agent Server (Bun) - one file.
// OpenAI-compatible API + server-side agent loop + 5 built-in skills.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// ---------- config (all via env vars) ----------
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.POLLINATIONS_API_KEY || "";
const UPSTREAM =
  process.env.POLLINATIONS_URL ||
  (API_KEY
    ? "https://gen.pollinations.ai/v1/chat/completions"
    : "https://text.pollinations.ai/openai"); // legacy keyless fallback
const DEFAULT_MODEL = process.env.POLLINATIONS_MODEL || "openai";
const SERVER_KEY = process.env.SERVER_API_KEY || ""; // optional: protects YOUR server
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 6);
const AGENT_MODEL = "pollinations-agent";
const UA = "pollinations-agent/1.0";

// ---------- helpers ----------
type Msg = { role: string; content: any; [k: string]: any };
type Skill = {
  name: string;
  description: string;
  params: string;
  run: (args: any) => Promise<string> | string;
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 24);
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
const fail = (status: number, message: string, type = "invalid_request_error") =>
  json({ error: { message, type, code: status } }, status);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n...[truncated]" : s);
const flat = (c: any): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("\n")
      : String(c ?? "");

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).hostname}`);
  return r.json();
}

// ---------- SKILL 1: calculator (safe parser, no eval) ----------
function calc(input: string): string {
  const s = String(input).toLowerCase().replace(/\*\*/g, "^").replace(/×/g, "*").replace(/÷/g, "/").replace(/\s+/g, "");
  if (!s || s.length > 200) throw new Error("empty or too long expression");
  let i = 0;
  const FN: Record<string, (...a: number[]) => number> = {
    sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, ln: Math.log, log: Math.log10, exp: Math.exp,
    min: Math.min, max: Math.max,
  };
  const CONST: Record<string, number> = { pi: Math.PI, e: Math.E };
  const expr = (): number => {
    let v = term();
    while (s[i] === "+" || s[i] === "-") { const op = s[i++]; const r = term(); v = op === "+" ? v + r : v - r; }
    return v;
  };
  const term = (): number => {
    let v = unary();
    while (s[i] === "*" || s[i] === "/" || s[i] === "%") {
      const op = s[i++]; const r = unary();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const unary = (): number => {
    if (s[i] === "-") { i++; return -unary(); }
    if (s[i] === "+") { i++; return unary(); }
    const b = atom();
    if (s[i] === "^") { i++; const ex = unary(); if (Math.abs(ex) > 1000) throw new Error("exponent too large"); return b ** ex; }
    return b;
  };
  const atom = (): number => {
    if (s[i] === "(") { i++; const v = expr(); if (s[i++] !== ")") throw new Error("missing )"); return v; }
    const rest = s.slice(i);
    const n = rest.match(/^(\d+\.?\d*|\.\d+)/);
    if (n) { i += n[0].length; return parseFloat(n[0]); }
    const id = rest.match(/^[a-z]+/);
    if (id) {
      const name = id[0]; i += name.length;
      if (s[i] === "(") {
        i++;
        const args: number[] = [];
        if (s[i] !== ")") { while (true) { args.push(expr()); if (s[i] === ",") i++; else break; } }
        if (s[i++] !== ")") throw new Error("missing )");
        const f = FN[name]; if (!f) throw new Error(`unknown function ${name}`);
        return f(...args);
      }
      if (name in CONST) return CONST[name];
      throw new Error(`unknown name ${name}`);
    }
    throw new Error(`unexpected '${s[i] ?? "end"}'`);
  };
  const v = expr();
  if (i < s.length) throw new Error(`unexpected '${s[i]}'`);
  if (!Number.isFinite(v)) throw new Error("result is not a finite number");
  return Number.isInteger(v) ? String(v) : String(+v.toPrecision(12));
}

// ---------- SKILL 5 helpers: safe URL reader ----------
function isPrivate(ip: string): boolean {
  if (ip.includes(":")) {
    const l = ip.toLowerCase();
    return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function assertPublic(u: URL) {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http/https URLs are allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.some((a) => isPrivate(a.address))) throw new Error("blocked: private or local address");
}
const htmlToText = (h: string) =>
  h.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
async function readLimited(r: Response, max: number): Promise<string> {
  const reader = r.body!.getReader(); const dec = new TextDecoder();
  let out = "", n = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length; out += dec.decode(value, { stream: true });
    if (n >= max) { await reader.cancel(); break; }
  }
  return out;
}
async function readUrl(raw: string): Promise<string> {
  let url = new URL(String(raw));
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url);
    const r = await fetch(url, {
      redirect: "manual", signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": UA, Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
    });
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get("content-type") || "";
    if (!/text|json|xml/.test(ct)) throw new Error(`unsupported content-type: ${ct || "unknown"}`);
    const body = await readLimited(r, 300_000);
    return clip(ct.includes("html") ? htmlToText(body) : body, 6000);
  }
  throw new Error("too many redirects");
}

// ---------- SKILL 4 helper: weather codes ----------
function wmo(c: number): string {
  if (c === 0) return "clear sky";
  if (c <= 3) return "partly cloudy";
  if (c === 45 || c === 48) return "fog";
  if (c >= 51 && c <= 57) return "drizzle";
  if (c >= 61 && c <= 67) return "rain";
  if (c >= 71 && c <= 77) return "snow";
  if (c >= 80 && c <= 82) return "rain showers";
  if (c >= 95) return "thunderstorm";
  return "unknown conditions";
}

// ---------- the 5 skills ----------
const SKILLS: Skill[] = [
  {
    name: "calculator",
    description: "Evaluate a math expression exactly. Supports + - * / % ^ ( ), sqrt, abs, round, floor, ceil, sin, cos, tan, ln, log, exp, min, max, pi, e.",
    params: '{"expression": string}',
    run: (a) => calc(a.expression),
  },
  {
    name: "datetime",
    description: "Get the current date and time in an IANA timezone (default Africa/Lagos).",
    params: '{"timezone"?: string}',
    run: (a) => {
      const tz = a.timezone || "Africa/Lagos";
      try {
        const now = new Date();
        const local = now.toLocaleString("en-GB", { timeZone: tz, dateStyle: "full", timeStyle: "long" });
        return `${local} (${tz}). UTC: ${now.toISOString()}`;
      } catch {
        throw new Error(`invalid timezone '${tz}'. Use IANA names like Europe/London`);
      }
    },
  },
  {
    name: "weather",
    description: "Get current weather for a city (Open-Meteo, no key needed).",
    params: '{"city": string}',
    run: async (a) => {
      const g = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(String(a.city))}&count=1`);
      const p = g.results?.[0];
      if (!p) return `City '${a.city}' not found.`;
      const w = await getJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}` +
          `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto`,
      );
      const c = w.current;
      return `${p.name}, ${p.country}: ${wmo(c.weather_code)}, ${c.temperature_2m}°C (feels ${c.apparent_temperature}°C), humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h.`;
    },
  },
  {
    name: "wikipedia",
    description: "Look up a topic on Wikipedia and return a short summary with its source link.",
    params: '{"query": string}',
    run: async (a) => {
      const s = await getJson(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=1&format=json&srsearch=${encodeURIComponent(String(a.query))}`,
      );
      const title = s.query?.search?.[0]?.title;
      if (!title) return `No Wikipedia result for '${a.query}'.`;
      const d = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`);
      return `${d.title}: ${d.extract}\nSource: ${d.content_urls?.desktop?.page ?? "wikipedia.org"}`;
    },
  },
  {
    name: "read_url",
    description: "Fetch a public web page (http/https) and return its readable text. Private/local addresses are blocked.",
    params: '{"url": string}',
    run: (a) => readUrl(a.url),
  },
];
const SKILL_MAP: Record<string, Skill> = Object.fromEntries(SKILLS.map((s) => [s.name, s]));

// ---------- upstream (Pollinations) ----------
const LEGACY_GET = process.env.LEGACY_GET_URL || "https://text.pollinations.ai";
function flatPrompt(msgs: Msg[]): string {
  let p = msgs.map((m) => `${m.role}: ${flat(m.content)}`).join("\n");
  if (p.length > 7000) p = p.slice(0, 2500) + "\n...\n" + p.slice(-4500); // keep URL short enough
  return p;
}
// keyless fallback: simple GET endpoint (needs no key), wrapped as an OpenAI-style response
async function legacyGet(body: any): Promise<Response> {
  const url = `${LEGACY_GET}/${encodeURIComponent(flatPrompt(body.messages || []))}?model=${encodeURIComponent(body.model || DEFAULT_MODEL)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { "User-Agent": UA } });
  if (!r.ok) return r;
  const text = await r.text();
  return new Response(
    JSON.stringify({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }),
    { headers: { "Content-Type": "application/json" } },
  );
}
async function upstream(body: any, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) {
    headers.Authorization = `Bearer ${API_KEY}`;
    return fetch(UPSTREAM, { method: "POST", headers, body: JSON.stringify(body), signal });
  }
  try {
    const r = await fetch(UPSTREAM, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (r.ok) return r;
  } catch {}
  return legacyGet({ ...body, stream: false });
}

// ---------- agent loop (prompt-based tool protocol: works with any model) ----------
const SYSTEM_PROMPT = `You are a helpful AI agent with tools.

Tools:
${SKILLS.map((s) => `- ${s.name} ${s.params}: ${s.description}`).join("\n")}

To use a tool, reply with ONLY one JSON object and nothing else:
{"tool":"<name>","args":{...}}
You will then receive the tool result. You may call several tools in turn.
When you can answer, reply in plain text with no JSON.
Use tools for math, current date/time, weather, facts and reading URLs. Never invent tool results.`;

function parseToolCall(text: string): { tool: string; args: any } | null {
  const t = text.replace(/```(?:json)?/gi, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(t.slice(a, b + 1));
    return o && typeof o.tool === "string" ? { tool: o.tool, args: o.args ?? {} } : null;
  } catch {
    return null;
  }
}

function mergeSystem(c: Msg[]): Msg[] {
  const sys = c.filter((m) => m.role === "system").map((m) => flat(m.content)).join("\n\n");
  const rest = c.filter((m) => m.role !== "system");
  const i = rest.findIndex((m) => m.role === "user");
  if (i >= 0) rest[i] = { ...rest[i], content: `${sys}\n\n---\nUser request:\n${flat(rest[i].content)}` };
  return rest;
}

async function runAgent(messages: Msg[], model: string, temperature?: number, onStep?: (name: string) => void) {
  const convo: Msg[] = [{ role: "system", content: SYSTEM_PROMPT }, ...messages.map((m) => ({ role: m.role, content: flat(m.content) }))];
  const trace: { tool: string; args: any; result: string }[] = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const ask = async (): Promise<string> => {
    let why = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      // attempt 0 = normal; later attempts put the instructions inside the user message
      const r = await upstream({ model, messages: attempt === 0 ? convo : mergeSystem(convo), temperature, stream: false });
      if (!r.ok) throw new Error(`upstream ${r.status}: ${clip(await r.text(), 300)}`);
      const d: any = await r.json();
      for (const k of Object.keys(usage) as (keyof typeof usage)[]) usage[k] += d.usage?.[k] || 0;
      if (process.env.AGENT_DEBUG) console.log("agent raw:", JSON.stringify(d).slice(0, 800));
      const m = d.choices?.[0]?.message;
      const text = String(m?.content ?? "").trim();
      const tc = m?.tool_calls?.[0]?.function; // upstream used native tool calling: convert it
      if (tc?.name) {
        let a: any = {};
        try { a = JSON.parse(tc.arguments || "{}"); } catch {}
        return JSON.stringify({ tool: tc.name, args: a });
      }
      if (text) return text;
      why = String(m?.reasoning ?? m?.reasoning_content ?? "");
    }
    throw new Error(`model returned empty content 3 times. Its reasoning was: ${clip(why, 250) || "(none)"}`);
  };
  for (let step = 0; step < MAX_STEPS; step++) {
    const text = await ask();
    const call = parseToolCall(text);
    if (!call) return { text, trace, usage };
    onStep?.(call.tool);
    const skill = SKILL_MAP[call.tool];
    let result: string;
    try {
      result = skill ? await skill.run(call.args) : `Unknown tool '${call.tool}'. Available: ${SKILLS.map((s) => s.name).join(", ")}`;
    } catch (e: any) {
      result = `Tool error: ${e?.message ?? e}`;
    }
    result = clip(result, 4000);
    trace.push({ tool: call.tool, args: call.args, result });
    convo.push(
      { role: "assistant", content: text },
      { role: "user", content: `Tool result (${call.tool}):\n${result}\n\nContinue. Answer the user in plain text if you have enough information.` },
    );
  }
  convo.push({ role: "user", content: "Step limit reached. Give your best final answer now in plain text with no tool calls." });
  return { text: await ask(), trace, usage };
}

// ---------- chat completions ----------
const SSE = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no", ...CORS };

async function chat(req: Request): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return fail(400, "Body must be valid JSON"); }
  if (body.prompt && !body.messages) body.messages = [{ role: "user", content: String(body.prompt) }];
  if (!Array.isArray(body.messages) || !body.messages.length) return fail(400, "'messages' must be a non-empty array");

  const agent = body.model === AGENT_MODEL || body.agent === true;
  const model = !body.model || body.model === AGENT_MODEL ? DEFAULT_MODEL : body.model;
  const stream = body.stream === true;
  const id = `chatcmpl-${uid()}`, created = Math.floor(Date.now() / 1000), shown = agent ? AGENT_MODEL : model;
  const chunk = (delta: any, finish: string | null = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: shown, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

  // ----- plain proxy mode: pass tools/params straight to Pollinations -----
  if (!agent) {
    let r: Response;
    try { r = await upstream({ ...body, model }, req.signal); }
    catch (e: any) { return fail(502, `Upstream unreachable: ${e?.message ?? e}`, "upstream_error"); }
    if (!r.ok) return fail(r.status, `Upstream error: ${clip(await r.text(), 500)}`, "upstream_error");
    const ct = r.headers.get("content-type") || "application/json";
    if (stream && ct.includes("application/json")) { // fallback gave a full answer: re-send it as SSE
      const d: any = await r.json();
      const text = String(d.choices?.[0]?.message?.content ?? "");
      const out = chunk({ role: "assistant", content: "" }) + (text.match(/\S+\s*/g) ?? [text]).map((w) => chunk({ content: w })).join("") + chunk({}, "stop") + "data: [DONE]\n\n";
      return new Response(out, { headers: SSE });
    }
    return new Response(r.body, { status: 200, headers: { ...(stream ? SSE : { "Content-Type": ct, ...CORS }) } });
  }

  // ----- agent mode: server-side loop with the 5 skills -----
  const msgs = body.messages as Msg[];
  const temp = typeof body.temperature === "number" ? body.temperature : undefined;
  if (!stream) {
    try {
      const out = await runAgent(msgs, model, temp);
      return json({
        id, object: "chat.completion", created, model: shown,
        choices: [{ index: 0, message: { role: "assistant", content: out.text }, finish_reason: "stop" }],
        usage: out.usage, agent_trace: out.trace,
      });
    } catch (e: any) { return fail(502, `Agent failed: ${e?.message ?? e}`, "upstream_error"); }
  }
  const enc = new TextEncoder();
  const readable = new ReadableStream({
    async start(ctrl) {
      const send = (s: string) => ctrl.enqueue(enc.encode(s));
      send(chunk({ role: "assistant", content: "" }));
      try {
        const out = await runAgent(msgs, model, temp, (name) => send(`: running tool ${name}\n\n`));
        for (const w of out.text.match(/\S+\s*/g) ?? [out.text]) send(chunk({ content: w }));
        send(chunk({}, "stop"));
      } catch (e: any) {
        send(`data: ${JSON.stringify({ error: { message: `Agent failed: ${e?.message ?? e}`, type: "upstream_error" } })}\n\n`);
      }
      send("data: [DONE]\n\n");
      ctrl.close();
    },
  });
  return new Response(readable, { headers: SSE });
}

// ---------- router ----------
export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method === "GET" && path === "/")
    return json({
      status: "ok", name: "pollinations-agent", agent_model: AGENT_MODEL, default_model: DEFAULT_MODEL,
      upstream: new URL(UPSTREAM).host, keyed: !!API_KEY, protected: !!SERVER_KEY,
      skills: SKILLS.map((s) => s.name),
      endpoints: ["POST /v1/chat/completions", "GET /v1/models", "GET /v1/skills", "POST /v1/skills/:name", "GET /health"],
    });
  if (req.method === "GET" && path === "/health") return json({ status: "ok" });

  if (SERVER_KEY && req.headers.get("authorization") !== `Bearer ${SERVER_KEY}`)
    return fail(401, "Invalid or missing API key", "authentication_error");

  if (req.method === "GET" && (path === "/v1/models" || path === "/models"))
    return json({
      object: "list",
      data: [...new Set([AGENT_MODEL, DEFAULT_MODEL])].map((id) => ({ id, object: "model", created: 0, owned_by: "pollinations" })),
    });
  if (req.method === "GET" && (path === "/v1/skills" || path === "/skills"))
    return json({ object: "list", data: SKILLS.map(({ name, description, params }) => ({ name, description, params })) });

  const sk = path.match(/^\/(?:v1\/)?skills\/([a-z_]+)$/);
  if (req.method === "POST" && sk) {
    const skill = SKILL_MAP[sk[1]];
    if (!skill) return fail(404, `Unknown skill '${sk[1]}'`);
    const args = await req.json().catch(() => ({}));
    try { return json({ name: skill.name, result: clip(String(await skill.run(args)), 8000) }); }
    catch (e: any) { return fail(400, `Skill error: ${e?.message ?? e}`); }
  }

  if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) return chat(req);
  return fail(404, `No route for ${req.method} ${path}`, "not_found");
}

// ---------- start ----------
if (typeof Bun !== "undefined") {
  Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    idleTimeout: 255, // seconds (Bun max) - fixes the "timed out after 10 seconds" warning
    async fetch(req) {
      const t = Date.now();
      try {
        const res = await handle(req);
        console.log(`${req.method} ${new URL(req.url).pathname} ${res.status} ${Date.now() - t}ms`);
        return res;
      } catch (e: any) {
        console.error("unhandled:", e);
        return fail(500, "Internal server error", "server_error");
      }
    },
  });
  console.log(`pollinations-agent listening on :${PORT} -> ${new URL(UPSTREAM).host} (${API_KEY ? "keyed" : "keyless/legacy"})`);
}
