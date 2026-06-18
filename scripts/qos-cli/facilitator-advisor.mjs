// Pluggable AI advisor for the facilitator daemon (v2).
//
// ADVISORY-ONLY: it *proposes* a one-line facilitation nudge (or null); the
// daemon's measured-disruption throttle decides whether to post it. The AI never
// gets authority. The facilitator is fully functional without it — `makeAdvisor`
// returns a disabled advisor when `--ai` is off or no API key is present, and the
// deterministic v1 behaviours carry the room.
//
// Two backends (pick with `--ai-backend`):
//   • api (default)         — Anthropic Messages API via global `fetch` (Node 18+), key from
//                             ANTHROPIC_API_KEY. Pay-as-you-go API credits.
//   • claude-code           — shells out to the local `claude` CLI in print mode, using the
//                             user's Claude login (Pro/Max subscription) — NO API credits.
// Calls are made only when the throttle would allow a post (the daemon gates them), so usage is
// bounded by the same budget/cooldowns.

import { spawn } from "node:child_process";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM = `You are a light-touch group facilitator in a small collaborative QuantumOS chat room.
Embody these norms: surface disagreement, then help the group reach agreement; make sure everyone
participates (include the silent); keep decisions concrete and actionable; never dominate.
You have NO authority — you only nudge; the group decides. Be terse and warm: at most one or two
short sentences, specific to what was actually said, no preamble, no sign-off. If no nudge is
warranted right now, reply with exactly: NONE`;

// `/facil ask` — answer a participant's question, primed about the facilitator itself,
// group discussion (Room_Best_Practices), and group decisions (the QuantumOS tools).
const ASK_SYSTEM = `You are a group facilitator daemon in a small collaborative QuantumOS chat room
(there may be other facilitators present — speak only for yourself, describe only your own behaviour),
answering a quick question from a participant. Be brief and concrete — 2 to 4 short sentences, plain
and warm, no preamble. You know:

- YOURSELF: a light-touch facilitator that mostly stays quiet and nudges to keep everyone included and
  decisions clear. You greet newcomers, ask the nameless to set a /name, invite quiet voices in, gently
  rebalance anyone dominating, and surface (dis)agreement. In-room commands: \`/facil\` (am I here?),
  \`/facil help\`, \`/facil ask <question>\`, \`/facil off\` and \`/facil on\` (mute/unmute). You have NO
  authority — you only nudge; the group decides, and can \`/gov trust\` or \`/gov censure\` you.
- GROUP DISCUSSION (best practices): work from complementary roles — Proposer, Skeptic (refute before
  closing), Integrator (merge compatible ideas), Evidence keeper (track known/assumed/unresolved/testable),
  Operator (what do we DO?), Boundary keeper (scope). Don't close a proposal unrefuted; take turns; include
  whoever is absent or silent.
- GROUP DECISIONS (tools in this app): \`/poll\` (approval or ranked vote), \`/probe\` (2/3-supermajority
  consensus reconciliation), \`/estimate\` (median + spread), \`/gov delegate\` and \`/gov trust\`
  (liquid-trust weighted voting), \`/gov censure\` (2/3-quorum accountability), and \`/lemma\` + \`/persist\`
  to record a decision of record.

Answer only the question asked. If you don't know, say so briefly.`;

const transcriptText = (transcript) =>
  (transcript || []).map((m) => `${m.name}: ${m.text}`).join("\n").slice(-3000);

function userPrompt(mode, ctx) {
  const t = transcriptText(ctx.transcript);
  if (mode === "ask") {
    const ctxLine = t ? `\n\nRecent room context (for reference):\n${t}` : "";
    return `A participant asks: "${ctx.question}"${ctxLine}\n\nAnswer briefly.`;
  }
  if (mode === "stimulate") {
    const quiet = ctx.silent?.length ? `\nPresent but quiet: ${ctx.silent.join(", ")}.` : "";
    return `The conversation has gone quiet. Recent transcript:\n${t}${quiet}\n\nPost ONE short prompt that re-engages the group or invites a quieter voice to weigh in — or NONE.`;
  }
  // synthesize / disagreement → agreement
  return `Recent transcript:\n${t}\n\nIf there is a real disagreement, name the crux in one sentence and suggest the single question or next step that would move toward agreement. If people are converging or there is no real disagreement, reply NONE.`;
}

// claude-code backend: shell out to the local `claude` CLI in non-interactive print
// mode. Uses the user's Claude login (Pro/Max subscription) — NO Anthropic API credits.
// The system text is appended via --append-system-prompt; the user prompt is fed on stdin.
function callClaudeCLI({ claudeBin, model, system, prompt, log, timeoutMs = 45_000 }) {
  return new Promise((resolve) => {
    const args = ["-p", "--output-format", "text", "--append-system-prompt", system];
    if (model) args.push("--model", model);
    let child;
    try {
      child = spawn(claudeBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) { log(`[facil] claude CLI spawn failed: ${e?.message ?? e}`); return resolve(null); }
    let out = "", err = "", done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} log("[facil] claude CLI timed out"); finish(null); }, timeoutMs);
    child.on("error", (e) => { log(`[facil] claude CLI error: ${e?.message ?? e} (is the \`claude\` CLI installed + logged in?)`); finish(null); });
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      if (code !== 0) { log(`[facil] claude CLI exit ${code}${err ? ": " + err.trim().slice(0, 200) : ""}`); return finish(null); }
      finish(out.trim());
    });
    try { child.stdin.write(prompt); child.stdin.end(); } catch (e) { log(`[facil] claude CLI stdin error: ${e?.message ?? e}`); finish(null); }
  });
}

export function makeAdvisor({ ai = false, backend = "api", apiKey = process.env.ANTHROPIC_API_KEY, model = null, claudeBin = "claude", log = () => {} } = {}) {
  backend = (backend === "cli" || backend === "claude") ? "claude-code" : (backend || "api");
  const apiModel = model || "claude-haiku-4-5-20251001";    // api backend default
  const cliModel = model || null;                            // claude-code: null = CLI's own default
  let enabled, label;
  if (!ai) { enabled = false; label = "off"; }
  else if (backend === "claude-code") { enabled = true; label = `claude-code${cliModel ? " " + cliModel : ""}`; }
  else { enabled = !!apiKey; label = enabled ? apiModel : "off"; if (!apiKey) log("[facil] --ai (api backend) set but ANTHROPIC_API_KEY missing — running deterministic only (try --ai-backend claude-code)"); }
  return {
    enabled,
    backend,
    model: label,
    /** mode: "ask" | "stimulate" | "synthesize". Returns a short string, or null. */
    async advise(mode, ctx) {
      if (!enabled) return null;
      const system = mode === "ask" ? ASK_SYSTEM : SYSTEM;
      const prompt = userPrompt(mode, ctx);
      const max_tokens = mode === "ask" ? 256 : 160;
      let text = null;
      if (backend === "claude-code") {
        text = await callClaudeCLI({ claudeBin, model: cliModel, system, prompt, log });
      } else {
        try {
          const res = await fetch(ANTHROPIC_URL, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: apiModel, max_tokens, system, messages: [{ role: "user", content: prompt }] }),
          });
          if (!res.ok) { log(`[facil] advisor HTTP ${res.status}`); return null; }
          const j = await res.json();
          text = (j?.content?.[0]?.text ?? "").trim();
        } catch (e) { log(`[facil] advisor error: ${e?.message ?? e}`); return null; }
      }
      if (!text || /^NONE\b/i.test(text)) return null;
      return text.slice(0, mode === "ask" ? 700 : 400);   // ask answers may be a few sentences; nudges stay terse
    },
  };
}
