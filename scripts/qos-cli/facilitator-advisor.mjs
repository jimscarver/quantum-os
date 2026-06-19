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

// Persona = the role-specific "who you are" line (overridable per role via makeAdvisor's
// `persona`); the norms / knowledge below are role-neutral and shared. The facilitator
// persona is the default when no role persona is supplied.
const DEFAULT_PERSONA =
  "You are a light-touch group facilitator: surface disagreement and then help the group converge, make sure everyone participates (include the silent), keep decisions concrete, and never dominate.";

const NUDGE_NORMS = `You are participating in a small collaborative QuantumOS chat room. You have NO
authority — you only nudge; the group decides. Be terse and warm: at most one or two short sentences,
specific to what was actually said, no preamble, no sign-off. If no nudge is warranted right now,
reply with exactly: NONE`;

// `/<cmd> ask` — answer a participant's question, primed about the agent itself, group
// discussion (Room_Best_Practices), and group decisions (the QuantumOS tools). Role-neutral;
// `cmd` is the agent's command prefix (e.g. facil, scribe).
const askKnowledge = (cmd) => `You are answering a quick question from a participant in a small
collaborative QuantumOS chat room. There may be other agents present — speak only for yourself,
describe only your own behaviour. Be brief and concrete — 2 to 4 short sentences, plain and warm,
no preamble. You know:

- YOURSELF: an opt-in room agent that mostly stays quiet. In-room commands: \`/${cmd}\` (am I here?),
  \`/${cmd} help\`, \`/${cmd} ask <question>\`, \`/${cmd} off\` and \`/${cmd} on\` (mute/unmute). You have NO
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

// `/<cmd> optimize` — facilitate a collective-optimization round (the room as a
// quantum-annealing-style optimizer; see Collective_Optimization.md).
const optimizeKnowledge = (cmd) => `You are facilitating a COLLECTIVE-OPTIMIZATION round in a small
collaborative QuantumOS chat room — the room as a quantum-annealing-style optimizer. The loop is:
frame → generate candidates → score (cheap, trust-weighted) → select & anneal (narrow each round) →
converge. Given the problem and the recent discussion, reply with three short parts, plainly and with
no preamble:
1. OBJECTIVE — restate the goal + key constraints in one line.
2. CANDIDATES — propose 2 to 4 concrete candidate solutions, ONE LINE EACH; OR, if candidates are
   already on the table in the discussion, refine/combine the leading ones (explore wide early,
   sharpen the leaders later — that narrowing IS the annealing). Keep them compact.
3. NEXT — suggest the single next step to score them: usually \`/estimate <metric>\` for a number
   (cost, value, risk, story points) or \`/poll\` (approval or ranked) for preference; then \`/probe\`
   to confirm convergence and \`/lemma\`+\`/persist\` to record the winner.
Be brief and concrete. This is a metaheuristic — aim for a strong solution, not a proof of optimality.`;

const transcriptText = (transcript) =>
  (transcript || []).map((m) => `${m.name}: ${m.text}`).join("\n").slice(-3000);

function userPrompt(mode, ctx) {
  const t = transcriptText(ctx.transcript);
  if (mode === "optimize") {
    const ctxLine = t ? `\n\nRecent discussion (candidates / scores so far):\n${t}` : "";
    return `Optimization problem: "${ctx.problem}"${ctxLine}\n\nFacilitate the next step of the round.`;
  }
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

export function makeAdvisor({ ai = false, backend = "api", apiKey = process.env.ANTHROPIC_API_KEY, model = null, claudeBin = "claude", persona = null, cmd = "facil", roleName = "facilitator", log = () => {} } = {}) {
  backend = (backend === "cli" || backend === "claude") ? "claude-code" : (backend || "api");
  // System prompt = role persona (or the facilitator default) + shared norms/knowledge.
  const sysFor = (mode) => {
    const who = persona || DEFAULT_PERSONA;
    if (mode === "ask") return `${who}\n\n${askKnowledge(cmd)}`;
    if (mode === "optimize") return `${who}\n\n${optimizeKnowledge(cmd)}`;
    return `${who}\n\n${NUDGE_NORMS}`;
  };
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
      const system = sysFor(mode);
      const prompt = userPrompt(mode, ctx);
      const max_tokens = mode === "optimize" ? 400 : mode === "ask" ? 256 : 160;
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
      return text.slice(0, mode === "optimize" ? 1400 : mode === "ask" ? 700 : 400);   // optimize is a 3-part round; ask a few sentences; nudges terse
    },
  };
}
