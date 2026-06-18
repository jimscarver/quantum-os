// Role registry for the generalized room-agent daemon (`agent.mjs`).
//
// An agent is a full room member with an identity, a measured-disruption budget,
// and an optional AI advisor. Its *role* selects a default name, a command prefix,
// an AI persona, and which proactive duties it performs. The facilitator is just
// one role; `scribe` and `greeter` show the generality (and compose: run several
// agents in one room and they de-conflict shared duties — see agent.mjs).
//
// Duties (each gated per-role; "lead-only" ones run only for the elected lead agent
// when multiple agents share the duty, so N agents don't all greet at once):
//   intro          one-time room hello on first peer            (lead-only)
//   greet          welcome each newcomer once                   (lead-only)
//   namePrompt     nudge the nameless to set a /name            (lead-only)
//   silentQuarter  invite a long-silent member to weigh in      (lead-only)
//   dominator      gently rebalance one voice taking the room   (lead-only)
//   discrepancy    surface (dis)agreement from consensus probes
//   stimulate      AI: re-engage after a lull                   (lead-only)
//   synthesize     AI: name the crux of a disagreement
// `ask` (the `/<cmd> ask` AI answer) is always available when --ai is on.

export const ROLES = {
  facilitator: {
    name: "facilitator",
    cmd: "facil",
    blurb:
      "a light-touch facilitator — I mostly stay quiet and only nudge to keep everyone included and decisions clear.",
    persona:
      "You are a light-touch group facilitator: surface disagreement and then help the group converge, make sure everyone participates (include the silent), keep decisions concrete and actionable, and never dominate.",
    duties: {
      intro: true, greet: true, namePrompt: true, silentQuarter: true,
      dominator: true, discrepancy: true, stimulate: true, synthesize: true,
    },
  },

  scribe: {
    name: "scribe",
    cmd: "scribe",
    blurb:
      "a scribe — I quietly track what the group decides and offer to record it as a lemma so late joiners can see it.",
    persona:
      "You are a meeting scribe: track what is decided, and when the group converges, offer to record the decision durably as a `/lemma` + `/persist` so late joiners see it. Summarize crisply when asked. Stay quiet during open discussion — you capture, you don't steer.",
    duties: {
      intro: true, greet: false, namePrompt: false, silentQuarter: false,
      dominator: false, discrepancy: true, stimulate: false, synthesize: false,
    },
  },

  greeter: {
    name: "greeter",
    cmd: "greeter",
    blurb:
      "a greeter — I welcome newcomers and help them set a name and get oriented.",
    persona:
      "You are a friendly room greeter: welcome newcomers warmly, help them set a display name with `/name`, and point them at `/help`. Don't interject in ongoing discussion — your job is the doorway, not the conversation.",
    duties: {
      intro: true, greet: true, namePrompt: true, silentQuarter: false,
      dominator: false, discrepancy: false, stimulate: false, synthesize: false,
    },
  },
};

export const DEFAULT_ROLE = "facilitator";

/** Resolve a role name (case-insensitive) to its definition, or null. */
export function resolveRole(name) {
  if (!name) return ROLES[DEFAULT_ROLE];
  const key = String(name).toLowerCase();
  return ROLES[key] ?? null;
}

/** Which duties a given role name performs (empty object if unknown). */
export function dutiesOf(roleName) {
  return ROLES[String(roleName).toLowerCase()]?.duties ?? {};
}
