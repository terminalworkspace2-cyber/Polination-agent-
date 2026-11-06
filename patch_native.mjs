import { readFileSync, writeFileSync } from "node:fs";
let s = readFileSync("server.ts", "utf8");
if (s.includes("native tool calling")) { console.log("already patched"); process.exit(0); }
const OLD = `      if (text) return text;
      why =`;
const NEW = `      const tc = m?.tool_calls?.[0]?.function; // upstream used native tool calling: convert it
      if (tc?.name) {
        let a: any = {};
        try { a = JSON.parse(tc.arguments || "{}"); } catch {}
        return JSON.stringify({ tool: tc.name, args: a });
      }
      if (text) return text;
      why =`;
if (!s.includes(OLD)) { console.error("pattern not found - run patch_agent.mjs first"); process.exit(1); }
writeFileSync("server.ts", s.replace(OLD, NEW));
console.log("native tool patch OK");
