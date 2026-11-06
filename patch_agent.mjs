import { readFileSync, writeFileSync } from "node:fs";
let s = readFileSync("server.ts", "utf8");
if (s.includes("mergeSystem")) { console.log("already patched"); process.exit(0); }

const OLD = `  const ask = async (): Promise<string> => {
    const r = await upstream({ model, messages: convo, temperature, stream: false });
    if (!r.ok) throw new Error(\`upstream \${r.status}: \${clip(await r.text(), 300)}\`);
    const d: any = await r.json();
    for (const k of Object.keys(usage) as (keyof typeof usage)[]) usage[k] += d.usage?.[k] || 0;
    return String(d.choices?.[0]?.message?.content ?? "").trim();
  };`;
const NEW = `  const ask = async (): Promise<string> => {
    let why = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      // attempt 0 = normal; later attempts put the instructions inside the user message
      const r = await upstream({ model, messages: attempt === 0 ? convo : mergeSystem(convo), temperature, stream: false });
      if (!r.ok) throw new Error(\`upstream \${r.status}: \${clip(await r.text(), 300)}\`);
      const d: any = await r.json();
      for (const k of Object.keys(usage) as (keyof typeof usage)[]) usage[k] += d.usage?.[k] || 0;
      if (process.env.AGENT_DEBUG) console.log("agent raw:", JSON.stringify(d).slice(0, 800));
      const m = d.choices?.[0]?.message;
      const text = String(m?.content ?? "").trim();
      if (text) return text;
      why = String(m?.reasoning ?? m?.reasoning_content ?? "");
    }
    throw new Error(\`model returned empty content 3 times. Its reasoning was: \${clip(why, 250) || "(none)"}\`);
  };`;
if (!s.includes(OLD)) { console.error("ask() block not found - server.ts was edited"); process.exit(1); }
s = s.replace(OLD, NEW);

const HELPER = `function mergeSystem(c: Msg[]): Msg[] {
  const sys = c.filter((m) => m.role === "system").map((m) => flat(m.content)).join("\\n\\n");
  const rest = c.filter((m) => m.role !== "system");
  const i = rest.findIndex((m) => m.role === "user");
  if (i >= 0) rest[i] = { ...rest[i], content: \`\${sys}\\n\\n---\\nUser request:\\n\${flat(rest[i].content)}\` };
  return rest;
}

`;
const k = s.indexOf("async function runAgent(");
if (k < 0) { console.error("runAgent not found"); process.exit(1); }
s = s.slice(0, k) + HELPER + s.slice(k);
writeFileSync("server.ts", s);
console.log("agent patch OK");
