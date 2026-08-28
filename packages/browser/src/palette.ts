// palette.ts — what commands exist, and the UI that offers them.
//
// The catalogue and the menu belong together: `SLASH_COMMANDS` is what the
// autocomplete matches against, `CMD_HELP` is what `/help <command>` prints, and
// `QUICK_ACTIONS` is the toolbar above the input. All three answer the same
// question — what can be typed here — and drift apart when they live apart.
//
// app.ts keeps the input element and the command dispatcher; this keeps what
// they offer.

// Per-command detailed help, shown by `/help <command>`. Keep each entry to a
// few scannable lines: syntax, key subcommands, and a short note/example.
export const CMD_HELP: Record<string, string[]> = {
  help: ["/help — list all commands.", "/help <command> — detailed help for one command (e.g. /help note)."],
  id: ["/id — show your peer ID and its ZFA proof (twist counts, spectral gap)."],
  name: ["/name <your name> — set the display name peers see in chat and the roster (same as the name field at the top).",
         "/name — with no argument, shows your current name.",
         "Your name is broadcast to peers (a signed `name` envelope) so they relabel you; it persists on this browser."],
  password: ["/password — encrypt your identity (the dyncap seed behind your anchor) under a password and get a qos-vault:v1:… recovery string.",
             "Prompts for the password in a masked dialog — it never enters the chat. Keeps your current anchor, so restoring it elsewhere is still you.",
             "If you're in any groups, it also replicates the encrypted vault into them (pure p2p) under your display-name handle — so you can recover with just /login <handle> after rejoining, no string to carry.",
             "/password show — re-display the recovery string saved on this browser.",
             "The vault is ciphertext (safe for peers to hold); only your password decrypts it. Don't run the same identity live in two browsers at once (it forks)."],
  login: ["/login <handle> — restore a former identity from the encrypted vault replicated in a group you've rejoined (pure p2p, no blob to carry). Prompts only for the password.",
          "/login — restore from a recovery string instead: paste your qos-vault:v1:… string (or leave blank to use this browser's saved one) + password.",
          "On success your seed/anchor and display name are restored, your group membership is re-linked to the restored identity, and it's re-announced so peers recognize you again. Wrong password fails cleanly with no change."],
  cap: ["/cap [label] — mint a new random ZFA capability token, local only (not broadcast).", "e.g. /cap alice-read"],
  grant: ["/grant [label] — mint a ZFA capability token AND broadcast it to the room.", "e.g. /grant moderator"],
  record: ["/record — start recording your screen with audio; /record again (or the ⏹ button) stops and saves it.",
           "Records what is on your screen, so it keeps whatever you had up — call tiles, chat, another window — and needs no call in progress.",
           "Audio: your mic, plus the tab's audio if you tick “Share tab audio” in the picker — that is what captures the other voices in the room.",
           "Saved as a .webm download (15 fps, ~540 MB/hour). The room is told when you start and stop."],
  zfa: ["/zfa <token> — validate a cap:label:hex capability; shows ZFA balance, spectral gap, twist counts."],
  braket: ["/braket <state> [state …] — evaluate bra-ket states as 2×2 density matrices.", "states: 0 1 + - i -i  (space-separated = superposition).", "e.g. /braket 0 1   ·   /braket -i"],
  qucalc: ["/qucalc [twists | @name | cap:token] — evaluate a RhoQuCalc twist sequence's ZFA balance.", "twists: symbolic ^v<>/\\+- or hex 0-7; compose lemmas with @name (or @[multi word]).", "e.g. /qucalc +-+-   ·   /qucalc @major @minor"],
  conj: ["/conj <twists> — Hermitian adjoint (reverse + parity-flip); flags self-adjoint inputs.", "Identity: E + E† ≡ ZFA. Accepts @name and cap:token too."],
  freq: ["/freq [n | twists] — ZFA frequency spectrum; C(2n,n) arrangements at level n (the 2:1 harmonic ladder)."],
  "qlf-action": ["/qlf-action <twists> — propose a QuCalc history string for the room to verify.", "The collaborative-study surface over the ZFA kernel; broadcast for /zfa-check.", "e.g. /qlf-action ^v<>/\\+-"],
  "zfa-check": ["/zfa-check <twists> — verify ZFA closure locally: is_zfa = is_count_balanced ∧ is_pauli_closed.", "Each peer runs its own kernel; no trusted evaluator. e.g. /zfa-check ^v^v"],
  coupling: ["/coupling [<twists> …] — classify a joint closure: independent, product, or coupled.",
             "No arguments cuts the room along what peers proposed with /qlf-action, one part each.",
             "Coupled means only the join closes — a shared closure, not two side by side.",
             "Sector counts are the QLF census's; baseline 80.3% coupled. e.g. /coupling ^ v"],
  estimate: ["/estimate new <question> — open a robust group numeric estimate (median by default).",
             "/estimate <number> — submit your estimate · /estimate status — median + IQR · /estimate close.",
             "--mean for the mean tally; median is whale/outlier-resistant. Used by gov-9stage & colab-study."],
  dump: ["/dump — summary of all logic shared this session."],
  lemma: ["/lemma — list named lemmas.", "/lemma <name> [twists] — register @name; omit twists to auto-allocate from the name.", "twists: symbolic / hex / cap:token / @ref1 @ref2.", "multi-word: /lemma [all men are mortal] ^v  →  reference as @[all men are mortal]"],
  request: ["/request <name> — broadcast that you need @name; whoever holds it sees a /pass prompt."],
  pass: ["/pass <name> <peer> — transfer a lemma @name directly to a named peer (removed from yours).", "multi-word: /pass [name with spaces] Alice"],
  note: ["/note [list] — held notes / currencies / receipts.   /note balance [currency]",
         "/note declare <currency> — issue a currency.",
         "/note grant <cur> <N> [| terms] — mint a denomination-N note; with terms → a stamped series cap:note-cur~hash.",
         "/note pass <cur> <N> <peer> · redeem <cur> <N> <issuer> · split <token> <a> · merge <t1> <t2>",
         "/note terms <cur[~hash]> · accept <cur~hash> — terms must be accepted before redeeming."],
  poll: ["/poll new <q> [| seed1, seed2] [ranked] — open a poll (approval or ranked-choice IRV); no seeds = open nominations.",
         "/poll add <option> · vote [id] <choices> · lock · close · status · remove · list",
         "ranked vote uses >, e.g. /poll vote pizza > salad > tacos"],
  forget: ["/forget <poll <id> | lemma <name> | note <token|cur denom> | group <name>> — remove an item.",
           "poll/lemma/group: the owner retracts for everyone (tombstoned, won't re-sync back); others hide it locally.",
           "note: deletes a held note (destroys its value, confirm required)."],
  gov: ["/gov new <name> · show <name> · list — liquid-democracy groups.",
        "/gov member add|remove <peer> [admin] · issue <title>",
        "/gov delegate <member> [on <issue>] · undelegate [on <issue>] — your vote flows to your delegate unless you vote (per-issue overrides global).",
        "/gov trust <member> <0-5> — confer a trust level BELOW your own (0 clears); admins are the root (5), vote weight = 1 + level (liquid trust).",
        "/gov censure <member> · uncensure <member> — flag undeserved trust; a ⅔ quorum of eligible censurers (min 2, even over an admin) discredits the target and slashes their vouchers.",
        "/gov vote <issue> | opt1, opt2 [ranked] — opens a delegation- and trust-weighted poll bound to the issue.",
        "/gov treasury declare|grant <m> <n>|balance · kudos <m> <n>|balance · say <msg> · status",
        "full reference: Governance.md"],
  rdv: ["/rdv swap <giveCur> <giveN> <getCur> <getN> <peer> — propose an atomic N-party swap (all-or-nothing).",
        "/rdv accept <id> · reject <id> · abort <id> · counter <id> <giveCur> <giveN> <getCur> <getN> · list"],
  dyncap: ["/dyncap status — your anchor / current seq / chain depth.", "/dyncap peers — all peers' anchors and seq depths (fork/contested flags)."],
  probe: ["/probe status — discrepancy-probe window state + ignored-for-sync peers.", "/probe clear — clear the ignored-for-sync list. (The probe runs automatically on join.)"],
  room: ["/room list · join <cap|url> · leave · ref — multi-room tabs (each room is a separate ZFA process).",
         "/room hide | show — keep the room capability out of the address bar, the share row and the sidebar, or put it back.",
         "Hidden is the default: reading a room cap IS joining it, and the address bar is in every screen share, screenshot and recording.",
         "Hiding loses nothing — joined rooms come back as tabs, copy still puts the link on your clipboard, and /room ref prints it."],
  share: ["/share <selector> to <room> — bridge an item into another joined room.", "selectors: @lemma · msg <text> · note <cur> <N>"],
  channel: ["/channel listen <name> · unlisten <name> · send <name> <text> · list — tagged broadcast messages (per-room subscriptions)."],
  facil: ["/facil [help|ask <question>|off|on] — relayed to facilitator daemon(s) in the room.", "The browser does NOT run facilitation and does not vouch for any facilitator — it only forwards the command. Each facilitator answers for ITSELF; trust its self-description only, judge it by its own (signed-name) replies, and note more than one may be present (or none).", "Typical: /facil (present?) · /facil help (it describes itself) · /facil ask <q> (brief AI answer, if it runs --ai) · /facil off|on (mute/unmute)."],
  script: ["/script <c1>; <c2>; … — run a sequential command chain; // skips a segment."],
  persist: ["/persist <@lemma | currency <name>> to <peer> — ask a peer to also hold your public state for redundancy.", "/persist accept <id> · reject <id> · list"],
  rhoqu: ["/rhoqu <source> — RhoQu macro language: process / new / | parallel / if / on channel / call → /commands.", "/rhoqu list · clear — manage registered on-channel handlers."],
  rholang: [
    "/rholang eval — run a rholang program on rnode and read the result back. Nothing is signed, nothing stored, no block.",
    "/rholang deploy — sign the program with your browser-held secp256k1 key and submit it. Costs phlo; lands in a block; outlives the room.",
    "/rholang status — rnode's version, network, shard, height and phlo floor. Warns when your shard does not match rnode's.",
    "eval and deploy open a syntax-highlighted editor (Ctrl+Enter runs, Esc cancels) that can load a .rho from disk, accept one dropped on it, and save the program back out. It keeps your last program so you can iterate on it, and Clear empties it. A program written inline — /rholang eval return!(42) — runs as typed.",
    "A deploy writes what it answered to your own registry slot — the uri your key derives, which only your key can write to. /rholang read collects it; /rholang nonce re-syncs the write counter if a second browser used the same key.",
    "/rholang locker — where the locker is; `locker <uri>` points at one, `locker install` publishes one at the uri your key derives (so it needs no reading back).",
    "/rholang register — create your identity record in the locker, anchored to your REV address. It is also the write that lets later lookups answer.",
    "/rholang bind <name> <uri> — name a capability so it outlives the room; resolve <name> reads it back; record shows your whole record; grant <name> mints a write-only capability for that one name.",
    "Each locker verb is its own deploy — rho:rchain:deployerId exists only inside a deploy, and that identity is what the locker keys on, so nobody can reach another identity's entry.",
    "/rholang macros — the approved capability macro library (grant · ballot · directory · mailbox · group · delegate · transfer · swap · philosophers · multisig); /rholang macro <name> <args…> runs one on its own.",
    "A program's macro call sites expand before it is linted or signed: %name(…) from that library, $name(…) from what this room defined with /macro. /rholang echo shows the result.",
    "Configure with /rholang rnode <url> · shard <id> · phlo <limit> [price] · key generate|<hex>|show|forget · config to show it all.",
    "eval runs read-only over finalized state; pure rholang and the qucalc powerbox both return values there. It cannot reach a deploy's own identity — rho:rchain:deployId and deployerId are unbound, since an exploratory deploy is not a deploy.",
  ],
  macro: [
    "Write a command. `/` is what the app ships; `+` is what somebody here wrote.",
    "/macro define $name($arg, …)  // what it does   — then the body on the lines below (Shift+Enter for a new line).",
    "A body of slash commands makes a +command:  /macro define $standup($topic) ⏎ /poll new $topic | yes, no ⏎ /gov say standup on $topic",
    "Then anyone in the room runs it: +standup \"Q4 budget\"  (quotes group an argument; topic=… names one).",
    "A body of rholang makes a fragment instead — call it as $name(…) inside /rholang eval or deploy, where its arguments stay rholang terms.",
    "A line beginning with / or + starts a new command; anything else continues the one before it, so a multi-line rholang program can be the argument to /rholang eval.",
    "/macro list — what this room has · show <name> — the definition as typed · find [pattern] — search names, docs and bodies · echo <name> [args] — what it expands to, running nothing.",
    "Definitions are room state: signed, shared with everyone here, and replayed to whoever joins next. First writer wins a name, and only that author can redefine or retract it.",
    "/forget macro <name> (or the ✕ in Commands) retracts yours for everyone, and hides anyone else's from your view.",
  ],
};

export interface SlashCmd { name: string; template: string; desc: string }
export const SLASH_COMMANDS: SlashCmd[] = [
  { name: "help",    template: "/help",       desc: "show all commands" },
  { name: "rholang", template: "/rholang ",    desc: "run rholang on rnode: eval · deploy · status" },
  { name: "macro",   template: "/macro ",      desc: "write a +command: define · list · show · find · echo" },
  { name: "id",      template: "/id",         desc: "your peer ID and ZFA proof" },
  { name: "password", template: "/password",  desc: "password-protect your identity (+ publish to groups)" },
  { name: "login",   template: "/login ",     desc: "restore identity: /login <handle> (from group) or paste a string" },
  { name: "cap",     template: "/cap ",       desc: "generate a new ZFA capability" },
  { name: "grant",   template: "/grant ",     desc: "generate + share a capability token" },
  { name: "zfa",     template: "/zfa ",       desc: "validate a capability token" },
  { name: "braket",  template: "/braket ",    desc: "evaluate bra-ket (0 1 + - i -i)" },
  { name: "record",  template: "/record",     desc: "record your screen with audio" },
  { name: "qucalc",  template: "/qucalc ",    desc: "evaluate a RhoQuCalc twist sequence" },
  { name: "conj",    template: "/conj ",      desc: "Hermitian adjoint of a twist sequence" },
  { name: "freq",    template: "/freq ",      desc: "ZFA frequency spectrum / C(2n,n)" },
  { name: "coupling", template: "/coupling ", desc: "shared closure, or several side by side?" },
  { name: "dump",    template: "/dump",       desc: "summary of logic shared this session" },
  { name: "lemma",   template: "/lemma ",     desc: "register / list named lemmas" },
  { name: "request", template: "/request ",   desc: "request a lemma from its holder" },
  { name: "pass",    template: "/pass ",      desc: "transfer a lemma to a named peer" },
  { name: "note",    template: "/note ",      desc: "promissory notes (grant|pass|redeem…)" },
  { name: "rdv",     template: "/rdv ",       desc: "atomic n-party swap (swap|accept…)" },
  { name: "poll",    template: "/poll ",      desc: "group vote (approval / ranked-choice)" },
  { name: "forget",  template: "/forget ",    desc: "remove a poll / lemma / note / group" },
  { name: "gov",     template: "/gov ",       desc: "liquid-democracy groups + delegated voting" },
  { name: "dyncap",  template: "/dyncap ",    desc: "dynamic capabilities (status|peers)" },
  { name: "probe",   template: "/probe ",     desc: "consensus discrepancy probe" },
  { name: "room",    template: "/room ",      desc: "multi-room tabs (list|join|leave)" },
  { name: "share",   template: "/share ",     desc: "bridge a lemma/note into another room" },
  { name: "channel", template: "/channel ",   desc: "tagged messages (listen|send|list)" },
  { name: "render",  template: "/render",     desc: "animate this room (perspectives, closures, groups)" },
  { name: "facil",   template: "/facil ",     desc: "ask/control the room facilitator (help|off|on)" },
  { name: "script",  template: "/script ",    desc: "run a sequential command chain" },
  { name: "persist", template: "/persist ",   desc: "agreed replication of public state" },
  { name: "rhoqu",   template: "/rhoqu ",     desc: "RhoQu macro → commands" },
];

interface QuickAction { label: string; ico: string; fill: string; hint: string }
const QUICK_ACTIONS: QuickAction[] = [
  { label: "Commands",   ico: "⌘", fill: "",                hint: "" },
  { label: "Call",       ico: "📞", fill: "",                hint: "" },
  { label: "Record",     ico: "⏺", fill: "",                hint: "" },
  { label: "Poll",       ico: "🗳", fill: "/poll new ",      hint: "e.g. /poll new Lunch?  — then everyone adds options & votes (add  | a, b  to seed)" },
  { label: "Capability", ico: "✦", fill: "/grant ",         hint: "name a capability, e.g. /grant alice-read" },
  { label: "Lemma",      ico: "≡", fill: "/lemma ",         hint: "name a lemma, e.g. /lemma mortality  (multi-word: /lemma [all men are mortal])" },
  { label: "Note",       ico: "$", fill: "/note grant ",    hint: "mint a note, e.g. /note grant USD 10  (add  | terms…  for a terms-stamped note)" },
  { label: "Swap",       ico: "⇄", fill: "/rdv swap ",      hint: "atomic swap, e.g. /rdv swap USD 30 EUR 20 Alice" },
  { label: "Channel",    ico: "#", fill: "/channel send ",  hint: "tagged message, e.g. /channel send news hello" },
];

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

export interface PaletteHost {
  /** The message box, which the palette fills in and focuses. */
  input: HTMLInputElement;
  /** Put a line in the transcript — a quick action's hint. */
  say(text: string): void;
  /** The Call action, which belongs to calls.ts rather than here. */
  toggleCall(): void;
  /** The Record action, which belongs to record.ts. */
  toggleRecord(): void;
}

export interface Palette {
  /** Build the quick-action toolbar into `row`. */
  mountActions(row: HTMLElement | null): void;
  isOpen(): boolean;
  hide(): void;
  /** The input changed: open on a bare command word, close otherwise. */
  onInput(value: string): void;
  /** Move the selection by `delta`, wrapping. */
  move(delta: number): void;
  /** Take the highlighted entry, or the first if none is highlighted. */
  accept(): void;
}

export function createPalette(host: PaletteHost, menu: HTMLElement | null): Palette {
  let sel = -1;
  let matches: SlashCmd[] = [];

  const isOpen = () => !!menu && !menu.hidden;
  const hide = () => { if (menu) menu.hidden = true; sel = -1; };

  function apply(c: SlashCmd): void {
    host.input.value = c.template;
    hide();
    host.input.focus();
  }

  function show(filter: string, all = false): void {
    if (!menu) return;
    const f = filter.toLowerCase();
    matches = all ? SLASH_COMMANDS.slice() : SLASH_COMMANDS.filter((c) => c.name.startsWith(f));
    if (matches.length === 0) { hide(); return; }
    menu.innerHTML = "";
    matches.forEach((c, i) => {
      const item = document.createElement("div");
      item.className = "cmd-item" + (i === sel ? " active" : "");
      const n = document.createElement("span"); n.className = "cmd-name"; n.textContent = "/" + c.name;
      const d = document.createElement("span"); d.className = "cmd-desc"; d.textContent = c.desc;
      item.appendChild(n); item.appendChild(d);
      // mousedown, not click: blur fires first and would close the menu under
      // the pointer before the click landed.
      item.addEventListener("mousedown", (e) => { e.preventDefault(); apply(c); });
      menu.appendChild(item);
    });
    menu.hidden = false;
  }

  return {
    mountActions(row) {
      if (!row) return;
      for (const a of QUICK_ACTIONS) {
        const btn = document.createElement("button");
        btn.className = "action-btn";
        // Named so a module that owns an action can find its own button —
        // recording repaints its one with the elapsed time.
        btn.dataset.action = a.label.toLowerCase();
        btn.title = a.hint || "browse all commands";
        const ico = document.createElement("span"); ico.className = "ico"; ico.textContent = a.ico;
        const lab = document.createElement("span"); lab.className = "act-label"; lab.textContent = a.label;
        btn.appendChild(ico);
        btn.appendChild(lab);
        btn.addEventListener("click", () => {
          if (a.label === "Commands") {
            if (isOpen()) hide();
            else { sel = -1; show("", true); host.input.focus(); }
            return;
          }
          if (a.label === "Call") { host.toggleCall(); return; }
          if (a.label === "Record") { host.toggleRecord(); return; }
          host.input.value = a.fill;
          host.input.focus();
          if (a.hint) host.say(a.hint);
          hide();
        });
        row.appendChild(btn);
      }
    },

    isOpen,
    hide,

    onInput(value) {
      // A bare command word and nothing else: `/no` yes, `//text` no, `/note x` no.
      if (value.startsWith("/") && !value.startsWith("//") && !value.includes(" ")) {
        sel = -1;
        show(value.slice(1), false);
      } else {
        hide();
      }
    },

    move(delta) {
      if (!menu || matches.length === 0) return;
      sel = (sel + delta + matches.length) % matches.length;
      Array.from(menu.children).forEach((el, i) => el.classList.toggle("active", i === sel));
      (menu.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
    },

    accept() {
      const pick = sel >= 0 ? matches[sel] : matches[0];
      if (pick) apply(pick);
    },
  };
}
