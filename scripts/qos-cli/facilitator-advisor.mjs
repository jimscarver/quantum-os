// Pluggable AI advisor for the facilitator daemon (v2).
//
// ADVISORY-ONLY: it *proposes* a one-line facilitation nudge (or null); the
// daemon's measured-disruption throttle decides whether to post it. The AI never
// gets authority. The facilitator is fully functional without it — `makeAdvisor`
// returns a disabled advisor when `--ai` is off or no API key is present, and the
// deterministic v1 behaviours carry the room.
//
// Uses the Anthropic Messages API via global `fetch` (Node 18+) — no SDK dep.
// Key from ANTHROPIC_API_KEY. Calls are made only when the throttle would allow a
// post (the daemon gates them), so usage is bounded by the same budget/cooldowns.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM = `You are a light-touch group facilitator in a small collaborative QuantumOS chat room.
Embody these norms: surface disagreement, then help the group reach agreement; make sure everyone
participates (include the silent); keep decisions concrete and actionable; never dominate.
You have NO authority — you only nudge; the group decides. Be terse and warm: at most one or two
short sentences, specific to what was actually said, no preamble, no sign-off. If no nudge is
warranted right now, reply with exactly: NONE`;

const transcriptText = (transcript) =>
  (transcript || []).map((m) => `${m.name}: ${m.text}`).join("\n").slice(-3000);

function userPrompt(mode, ctx) {
  const t = transcriptText(ctx.transcript);
  if (mode === "stimulate") {
    const quiet = ctx.silent?.length ? `\nPresent but quiet: ${ctx.silent.join(", ")}.` : "";
    return `The conversation has gone quiet. Recent transcript:\n${t}${quiet}\n\nPost ONE short prompt that re-engages the group or invites a quieter voice to weigh in — or NONE.`;
  }
  // synthesize / disagreement → agreement
  return `Recent transcript:\n${t}\n\nIf there is a real disagreement, name the crux in one sentence and suggest the single question or next step that would move toward agreement. If people are converging or there is no real disagreement, reply NONE.`;
}

export function makeAdvisor({ ai = false, apiKey = process.env.ANTHROPIC_API_KEY, model = "claude-haiku-4-5-20251001", log = () => {} } = {}) {
  const enabled = !!(ai && apiKey);
  if (ai && !apiKey) log("[facil] --ai set but ANTHROPIC_API_KEY missing — running deterministic only");
  return {
    enabled,
    model,
    /** mode: "stimulate" | "synthesize". Returns a short nudge string, or null. */
    async advise(mode, ctx) {
      if (!enabled) return null;
      try {
        const res = await fetch(ANTHROPIC_URL, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model, max_tokens: 160, system: SYSTEM, messages: [{ role: "user", content: userPrompt(mode, ctx) }] }),
        });
        if (!res.ok) { log(`[facil] advisor HTTP ${res.status}`); return null; }
        const j = await res.json();
        const text = (j?.content?.[0]?.text ?? "").trim();
        if (!text || /^NONE\b/i.test(text)) return null;
        return text.slice(0, 400);
      } catch (e) { log(`[facil] advisor error: ${e?.message ?? e}`); return null; }
    },
  };
}
