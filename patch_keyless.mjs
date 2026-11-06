import { readFileSync, writeFileSync } from "node:fs";
let s = readFileSync("server.ts", "utf8");
if (s.includes("legacyGet")) { console.log("already patched"); process.exit(0); }

const a = s.indexOf("// ---------- upstream (Pollinations) ----------");
const b = s.indexOf("// ---------- agent loop");
if (a < 0 || b < 0) { console.error("markers not found - server.ts was edited"); process.exit(1); }

const NEW_UP = `// ---------- upstream (Pollinations) ----------
const LEGACY_GET = process.env.LEGACY_GET_URL || "https://text.pollinations.ai";
function flatPrompt(msgs: Msg[]): string {
  let p = msgs.map((m) => \`\${m.role}: \${flat(m.content)}\`).join("\\n");
  if (p.length > 7000) p = p.slice(0, 2500) + "\\n...\\n" + p.slice(-4500); // keep URL short enough
  return p;
}
// keyless fallback: simple GET endpoint (needs no key), wrapped as an OpenAI-style response
async function legacyGet(body: any): Promise<Response> {
  const url = \`\${LEGACY_GET}/\${encodeURIComponent(flatPrompt(body.messages || []))}?model=\${encodeURIComponent(body.model || DEFAULT_MODEL)}\`;
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
    headers.Authorization = \`Bearer \${API_KEY}\`;
    return fetch(UPSTREAM, { method: "POST", headers, body: JSON.stringify(body), signal });
  }
  try {
    const r = await fetch(UPSTREAM, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (r.ok) return r;
  } catch {}
  return legacyGet({ ...body, stream: false });
}

`;
s = s.slice(0, a) + NEW_UP + s.slice(b);

const OLD_RET = `    return new Response(r.body, { status: 200, headers: { ...(stream ? SSE : { "Content-Type": ct, ...CORS }) } });`;
const NEW_RET = `    if (stream && ct.includes("application/json")) { // fallback gave a full answer: re-send it as SSE
      const d: any = await r.json();
      const text = String(d.choices?.[0]?.message?.content ?? "");
      const out = chunk({ role: "assistant", content: "" }) + (text.match(/\\S+\\s*/g) ?? [text]).map((w) => chunk({ content: w })).join("") + chunk({}, "stop") + "data: [DONE]\\n\\n";
      return new Response(out, { headers: SSE });
    }
    return new Response(r.body, { status: 200, headers: { ...(stream ? SSE : { "Content-Type": ct, ...CORS }) } });`;
if (!s.includes(OLD_RET)) { console.error("proxy return line not found"); process.exit(1); }
s = s.replace(OLD_RET, NEW_RET);
writeFileSync("server.ts", s);
console.log("patched OK");
