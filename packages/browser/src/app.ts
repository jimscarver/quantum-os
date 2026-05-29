import { loadZfa, generateCapability, validateCapability,
         spectralGap, achievesZfa } from "./zfa.js";
import { QOSPeer } from "./peer.js";
import { parseNoteLabel, denomination as noteDenomination,
         mintCurrencyToken, mintNote, mintReceipt,
         splitNote, mergeNotes } from "./notes.js";

// ---------------------------------------------------------------------------
// Room ID from URL hash: #room=cap:..., or generate a new one and set hash.
// ---------------------------------------------------------------------------

function getRoomId(): string {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const existing = params.get("room");
  if (existing) return existing;
  const id = generateCapability("room");
  params.set("room", id);
  window.location.hash = params.toString();
  return id;
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const sidebarEl       = document.getElementById("sidebar")!;
const overlayEl       = document.getElementById("sidebar-overlay")!;
const toggleBtn       = document.getElementById("sidebar-toggle") as HTMLButtonElement;
const myNameEl        = document.getElementById("my-name") as HTMLInputElement;
const myIdEl          = document.getElementById("my-id")!;
const roomIdEl        = document.getElementById("room-id")!;
const DEFAULT_SIGNAL  = "wss://quantum-os-signaling.onrender.com";
const signalUrlEl     = document.getElementById("signal-url") as HTMLInputElement;
const stunUrlEl       = document.getElementById("stun-url") as HTMLInputElement;
const connectBtn      = document.getElementById("connect-btn") as HTMLButtonElement;
const statusDot       = document.getElementById("status-dot")!;
const statusText      = document.getElementById("status-text")!;
const peerList        = document.getElementById("peer-list")!;
const peerCount       = document.getElementById("peer-count")!;
const roomProcessEl   = document.getElementById("room-process")!;
const messagesEl      = document.getElementById("messages")!;
const msgInput        = document.getElementById("msg-input") as HTMLInputElement;
const sendBtn         = document.getElementById("send-btn") as HTMLButtonElement;
const shareLink       = document.getElementById("share-link") as HTMLAnchorElement;
const copyBtn         = document.getElementById("copy-btn") as HTMLButtonElement;
const lemmaListEl     = document.getElementById("lemma-list")!;
const lemmaCountEl    = document.getElementById("lemma-count")!;
const currencyListEl  = document.getElementById("currency-list")!;
const currencyCountEl = document.getElementById("currency-count")!;
const noteListEl      = document.getElementById("note-list")!;
const noteCountEl     = document.getElementById("note-count")!;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const peers = new Set<string>();
const peerNames = new Map<string, string>();   // peerId → display name
// Debounce signaling-only disconnects: peerId → timer. If a peer rejoins before
// the timer fires (signaling blip), suppress the left/joined pair entirely.
const pendingLeaves = new Map<string, ReturnType<typeof setTimeout>>();
let myName: string = localStorage.getItem("qos-name") ?? "";
let qpeer: QOSPeer | null = null;

type LogEntry = { who: string; cmd: string; arg: string; summary: string };
const sessionLog: LogEntry[] = [];

interface LemmaEntry { twists: string; who: string; cap?: string }
const lemmaStore = new Map<string, LemmaEntry>();

interface NoteEntry { token: string; currency: string; denomination: number; receivedFrom?: string }
interface ReceiptEntry { token: string; currency: string; denomination: number; issuer: string }
interface RedemptionRecord { token: string; currency: string; denomination: number; redeemer: string; at: number }
interface KnownCurrency { currency: string; token: string; issuer: string }
const currencyTokens = new Map<string, string>();          // currency → cap:token-<currency>:…  (mine, with bearer authority)
const noteStore = new Map<string, NoteEntry>();             // token → entry
const receiptStore = new Map<string, ReceiptEntry>();       // token → entry
const redemptionsHonored = new Map<string, RedemptionRecord>(); // redeemed-token → record
const knownCurrencies = new Map<string, KnownCurrency>();   // token → entry  (public registry: everyone's declarations)

function lemmaToCapToken(name: string, tw: Uint8Array): string {
  return `cap:${name}:${Array.from(tw).map(b => b.toString(16)).join("")}`;
}

function allocateTwists(name: string): Uint8Array {
  // Deterministic ZFA-balanced sequence: each char yields one pos + one neg twist.
  const result: number[] = [];
  for (const c of name) {
    const code = c.charCodeAt(0);
    result.push((code & 3) * 2);            // pos: 0, 2, 4, or 6
    result.push(((code >> 2) & 3) * 2 + 1); // neg: 1, 3, 5, or 7
  }
  return new Uint8Array(result);
}

function saveLemmas(): void {
  const data = Object.fromEntries([...lemmaStore.entries()].map(([k, v]) => [k, v]));
  localStorage.setItem(`qos-lemmas-${getRoomId()}`, JSON.stringify(data));
}

function loadLemmas(): void {
  const raw = localStorage.getItem(`qos-lemmas-${getRoomId()}`);
  if (!raw) return;
  try {
    const data = JSON.parse(raw) as Record<string, LemmaEntry>;
    for (const [name, entry] of Object.entries(data)) lemmaStore.set(name, entry);
    renderLemmas();
  } catch { /* ignore corrupt data */ }
}

function saveNotes(): void {
  const room = getRoomId();
  localStorage.setItem(`qos-currencies-${room}`,       JSON.stringify(Object.fromEntries(currencyTokens)));
  localStorage.setItem(`qos-notes-${room}`,            JSON.stringify(Object.fromEntries(noteStore)));
  localStorage.setItem(`qos-receipts-${room}`,         JSON.stringify(Object.fromEntries(receiptStore)));
  localStorage.setItem(`qos-redemptions-${room}`,      JSON.stringify(Object.fromEntries(redemptionsHonored)));
  localStorage.setItem(`qos-known-currencies-${room}`, JSON.stringify(Object.fromEntries(knownCurrencies)));
}

function loadNotes(): void {
  const room = getRoomId();
  const tryLoad = <T>(key: string, set: (k: string, v: T) => void) => {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    try {
      const data = JSON.parse(raw) as Record<string, T>;
      for (const [k, v] of Object.entries(data)) set(k, v);
    } catch { /* ignore */ }
  };
  tryLoad<string>          (`qos-currencies-${room}`,       (k, v) => currencyTokens.set(k, v));
  tryLoad<NoteEntry>       (`qos-notes-${room}`,            (k, v) => noteStore.set(k, v));
  tryLoad<ReceiptEntry>    (`qos-receipts-${room}`,         (k, v) => receiptStore.set(k, v));
  tryLoad<RedemptionRecord>(`qos-redemptions-${room}`,      (k, v) => redemptionsHonored.set(k, v));
  tryLoad<KnownCurrency>   (`qos-known-currencies-${room}`, (k, v) => knownCurrencies.set(k, v));
  // Migration: seed knownCurrencies from currencies I issue if the registry is empty.
  if (knownCurrencies.size === 0 && currencyTokens.size > 0) {
    const me = myName || "you";
    for (const [currency, token] of currencyTokens) {
      knownCurrencies.set(token, { currency, token, issuer: me });
    }
    saveNotes();
  }
  renderNotes();
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setStatus(state: "disconnected" | "connecting" | "connected", label: string): void {
  statusDot.className = `status-dot ${state === "disconnected" ? "" : state}`;
  statusText.textContent = label;
  statusText.style.color = state === "connected" ? "#4caf50"
                         : state === "connecting" ? "#ff9800"
                         : "#555";
}

function addMessage(from: string, text: string, kind: "peer" | "self" | "system" = "peer", label?: string): void {
  const div = document.createElement("div");
  div.className = `msg${kind === "system" ? " system-line" : ""}`;
  const fromEl = document.createElement("span");
  fromEl.className = `from ${kind}`;
  fromEl.textContent = kind === "system" ? "·"
                     : kind === "self"   ? (myName || "you")
                     : (label ?? shortId(from));
  const textEl = document.createElement("span");
  textEl.className = "text";
  textEl.textContent = text;
  div.appendChild(fromEl);
  div.appendChild(textEl);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function shortId(id: string): string {
  const parts = id.split(":");
  const hex = parts[2] ?? id;
  return hex.slice(0, 8) + "…";
}

function peerLabel(id: string): string {
  return peerNames.get(id) ?? shortId(id);
}

function findPeerByName(name: string): string | null {
  const lower = name.toLowerCase();
  for (const [id, peerName] of peerNames) {
    if (peerName.toLowerCase() === lower) return id;
  }
  for (const [id, peerName] of peerNames) {
    if (peerName.toLowerCase().startsWith(lower)) return id;
  }
  return null;
}

function renderRoomProcess(): void {
  const allPeers = qpeer ? [qpeer.peerId, ...[...peers]] : [...peers];
  if (allPeers.length === 0) { roomProcessEl.textContent = "—"; return; }

  let totalPos = 0, totalNeg = 0;
  const peerLines: string[] = [];
  for (const id of allPeers) {
    const tw = tokenTwists(id);
    const label = id === qpeer?.peerId
      ? (myName || shortId(id)) + " (you)"
      : peerLabel(id);
    if (tw) {
      const { pos, neg } = twistStats(tw);
      totalPos += pos; totalNeg += neg;
      peerLines.push(`  action(${label})  ${pos}+/${neg}-`);
    }
  }
  const gap = Math.abs(totalPos - totalNeg);
  const balanced = totalPos === totalNeg;
  const lines = [
    "parallel(",
    ...peerLines,
    ")",
    `ZFA: ${balanced ? "✓" : "✗"}  gap: ${gap}  total twists: ${totalPos + totalNeg}`,
  ];
  if (qpeer) {
    const ptw = tokenTwists(qpeer.peerId);
    const pLevel = ptw ? zfaFreqLevel(ptw) : null;
    if (pLevel !== null) {
      lines.push(`freq level: ${pLevel}  C(${2*pLevel},${pLevel}) = ${zfaMultiplicity(pLevel).toLocaleString()}`);
    }
  }
  roomProcessEl.textContent = lines.join("\n");
}

function renderPeers(): void {
  peerCount.textContent = String(peers.size);
  peerList.innerHTML = "";
  if (qpeer) {
    const li = document.createElement("li");
    li.className = "you";
    li.textContent = `${myName || shortId(qpeer.peerId)} (you)`;
    peerList.appendChild(li);
  }
  for (const id of peers) {
    const li = document.createElement("li");
    li.textContent = peerLabel(id);
    li.title = id;
    li.style.cursor = "pointer";
    li.addEventListener("click", () => {
      msgInput.value = `/qucalc ${id}`;
      msgInput.focus();
    });
    peerList.appendChild(li);
  }
  renderRoomProcess();
}

function renderLemmas(): void {
  lemmaCountEl.textContent = String(lemmaStore.size);
  lemmaListEl.innerHTML = "";
  for (const [name, entry] of lemmaStore) {
    const li = document.createElement("li");
    li.textContent = `@${name}`;
    li.title = `${entry.twists}${entry.cap ? `  cap: ${entry.cap}` : ""}  (by ${entry.who})`;
    li.style.cursor = "pointer";
    li.addEventListener("click", () => { msgInput.value = `/qucalc @${name}`; msgInput.focus(); });
    lemmaListEl.appendChild(li);
  }
}

function renderNotes(): void {
  currencyCountEl.textContent = String(knownCurrencies.size);
  currencyListEl.innerHTML = "";
  // List my own issued currencies first (with ✦), then others (with issuer label).
  const mine: KnownCurrency[]  = [];
  const others: KnownCurrency[] = [];
  for (const entry of knownCurrencies.values()) {
    if (currencyTokens.get(entry.currency) === entry.token) mine.push(entry);
    else others.push(entry);
  }
  for (const entry of mine) {
    const li = document.createElement("li");
    li.textContent = `✦ ${entry.currency}`;
    li.title = `${entry.token}  (you issue ${entry.currency})`;
    li.style.cursor = "pointer";
    li.addEventListener("click", () => { msgInput.value = `/note grant ${entry.currency} `; msgInput.focus(); });
    currencyListEl.appendChild(li);
  }
  for (const entry of others) {
    const li = document.createElement("li");
    li.textContent = `${entry.currency}  (by ${entry.issuer})`;
    li.title = `${entry.token}  (issued by ${entry.issuer})`;
    li.style.cursor = "pointer";
    li.addEventListener("click", () => {
      msgInput.value = `/note redeem ${entry.currency} `;
      msgInput.focus();
    });
    currencyListEl.appendChild(li);
  }
  noteCountEl.textContent = String(noteStore.size);
  noteListEl.innerHTML = "";
  for (const n of noteStore.values()) {
    const li = document.createElement("li");
    const fromTag = n.receivedFrom ? `  (from ${n.receivedFrom})` : "";
    li.textContent = `${n.currency} ${n.denomination}${fromTag}`;
    li.title = n.token;
    li.style.cursor = "pointer";
    li.addEventListener("click", () => {
      msgInput.value = `/note pass ${n.currency} ${n.denomination} `;
      msgInput.focus();
    });
    noteListEl.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// ZFA helpers for slash commands
// ---------------------------------------------------------------------------

function tokenTwists(token: string): Uint8Array | null {
  const parts = token.split(":");
  if (parts.length < 3 || parts[0] !== "cap") return null;
  const arr = Uint8Array.from(
    [...parts[2]].map(c => parseInt(c, 16)).filter(n => n >= 0 && n < 8)
  );
  return arr.length > 0 ? arr : null;
}

function twistStats(twists: Uint8Array): { pos: number; neg: number; gap: number; balanced: boolean } {
  const POS = new Set([0, 2, 4, 6]);
  let pos = 0;
  for (const t of twists) if (POS.has(t)) pos++;
  const neg = twists.length - pos;
  const gap = spectralGap(twists);
  return { pos, neg, gap, balanced: achievesZfa(twists) };
}

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return Math.round(r);
}

function zfaMultiplicity(n: number): number { return binomial(2 * n, n); }

function zfaFreqLevel(twists: Uint8Array): number | null {
  return twists.length % 2 === 0 ? twists.length / 2 : null;
}

// ---------------------------------------------------------------------------
// Form matrix math for /braket — toMatrix = [[t+z, x−iy],[x+iy, t−z]]
// ---------------------------------------------------------------------------

interface FormF { t: number; x: number; y: number; z: number }
const STATE_FORMS: Record<string, FormF> = {
  "0":  { t: 0.5, x: 0,    y: 0,    z:  0.5 },
  "1":  { t: 0.5, x: 0,    y: 0,    z: -0.5 },
  "+":  { t: 0.5, x: 0.5,  y: 0,    z:  0   },
  "-":  { t: 0.5, x: -0.5, y: 0,    z:  0   },
  "i":  { t: 0.5, x: 0,    y: 0.5,  z:  0   },
  "-i": { t: 0.5, x: 0,    y: -0.5, z:  0   },
};
const STATE_KET: Record<string, string> = {
  "0": "|0⟩", "1": "|1⟩", "+": "|+⟩", "-": "|-⟩", "i": "|i⟩", "-i": "|-i⟩",
};
const STATE_BRA: Record<string, string> = {
  "0": "⟨0|", "1": "⟨1|", "+": "⟨+|", "-": "⟨-|", "i": "⟨i|", "-i": "⟨-i|",
};

type C2 = [number, number];
type M2x2 = [[C2, C2], [C2, C2]];

function formToMatrix(f: FormF): M2x2 {
  return [
    [[f.t + f.z, 0],    [f.x, -f.y]],
    [[f.x,       f.y],  [f.t - f.z, 0]],
  ];
}

function addM(a: M2x2, b: M2x2): M2x2 {
  return [
    [[a[0][0][0]+b[0][0][0], a[0][0][1]+b[0][0][1]], [a[0][1][0]+b[0][1][0], a[0][1][1]+b[0][1][1]]],
    [[a[1][0][0]+b[1][0][0], a[1][0][1]+b[1][0][1]], [a[1][1][0]+b[1][1][0], a[1][1][1]+b[1][1][1]]],
  ];
}

function fmtC2(c: C2): string {
  const eps = 1e-10;
  const r  = Math.abs(c[0]) < eps ? 0 : c[0];
  const im = Math.abs(c[1]) < eps ? 0 : c[1];
  const fr = (v: number) =>
    Math.abs(v - Math.round(v)) < eps
      ? String(Math.round(v))
      : v.toFixed(3).replace(/\.?0+$/, "");
  if (im === 0) return fr(r);
  if (r  === 0) return Math.abs(im) === 1 ? (im > 0 ? "i" : "-i") : `${fr(im)}i`;
  const iStr = Math.abs(im) === 1
    ? (im > 0 ? "+i" : "-i")
    : `${im > 0 ? "+" : ""}${fr(im)}i`;
  return `${fr(r)}${iStr}`;
}

function fmtMatrix(m: M2x2): [string, string] {
  const a = fmtC2(m[0][0]), b = fmtC2(m[0][1]);
  const c = fmtC2(m[1][0]), d = fmtC2(m[1][1]);
  const w = Math.max(a.length, c.length);
  const pad = (s: string) => s.padStart(w);
  return [`  ⎡ ${pad(a)}  ${b} ⎤`, `  ⎣ ${pad(c)}  ${d} ⎦`];
}

// ---------------------------------------------------------------------------
// Twist helpers for /qucalc — alphabet {^=0, v=1, >=2, <=3, /=4, \=5, +=6, -=7}
// ---------------------------------------------------------------------------

const TWIST_SYM: Record<string, number> = {
  "^": 0, "v": 1, ">": 2, "<": 3, "/": 4, "\\": 5, "+": 6, "-": 7,
};
const TWIST_NAME = ["^", "v", ">", "<", "/", "\\", "+", "-"];

function twistToSymbol(t: number): string { return TWIST_NAME[t] ?? "?"; }
function twistsToSymbolic(tw: Uint8Array): string { return [...tw].map(twistToSymbol).join(""); }

function parseSymbolicTwists(s: string): Uint8Array | null {
  const result: number[] = [];
  for (const c of s.replace(/\s/g, "")) {
    if (c >= "0" && c <= "7") result.push(Number(c));
    else if (c in TWIST_SYM) result.push(TWIST_SYM[c]);
    else return null;
  }
  return result.length > 0 ? new Uint8Array(result) : null;
}

function resolveLemmaToBytes(twistsStr: string): Uint8Array | null {
  if (twistsStr.startsWith("cap:")) return tokenTwists(twistsStr);
  return parseSymbolicTwists(twistsStr);
}

function expandLemmaRefs(arg: string): {
  expanded: string;
  components: Array<{ label: string | null; twists: string }>;
} | null {
  const tokens = arg.trim().split(/\s+/);
  const components: Array<{ label: string | null; twists: string }> = [];
  const parts: string[] = [];
  for (const tok of tokens) {
    if (tok.startsWith("@")) {
      const name = tok.slice(1);
      const entry = lemmaStore.get(name);
      if (!entry) return null;
      const tw = tokenTwists(entry.twists);
      const resolved = entry.twists.startsWith("cap:") && tw
        ? twistsToSymbolic(tw)
        : entry.twists;
      parts.push(resolved);
      components.push({ label: name, twists: resolved });
    } else if (tok.length > 0) {
      parts.push(tok);
      components.push({ label: null, twists: tok });
    }
  }
  return { expanded: parts.join(""), components };
}

// ---------------------------------------------------------------------------
// Slash command handler — returns collected output lines for broadcast
// ---------------------------------------------------------------------------

function handleCommand(raw: string): string[] {
  const parts = raw.slice(1).trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ");
  const lines: string[] = [];
  const sys = (text: string) => { addMessage("", text, "system"); lines.push(text); };

  switch (cmd) {
    case "help":
      sys("QLF slash commands:");
      sys("  /help            — show this help");
      sys("  /id              — your peer ID and ZFA proof");
      sys("  /room            — room capability token");
      sys("  /cap [label]     — generate a new ZFA capability");
      sys("  /grant [label]   — generate and share a ZFA capability token");
      sys("  /zfa [token]     — validate a capability token");
      sys("  /braket <state>  — evaluate bra-ket (states: 0 1 + - i -i)");
      sys("  /qucalc [twists] — evaluate RhoQuCalc twist sequence");
      sys("  /freq [n|twists] — ZFA frequency spectrum; C(2n,n) arrangements at level n");
      sys("  /dump            — summary of all logic shared this session");
      sys("  /lemma           — list named lemmas");
      sys("  /lemma <n> [tw]  — register @n; omit twists to auto-allocate from name");
      sys("  /request <n>     — request @n from whoever holds it");
      sys("  /pass <n> <peer> — transfer @n directly to a named peer");
      sys("  /note [sub]      — promissory notes (declare|grant|pass|redeem|split|merge|balance)");
      sys("  @name in args    — expand named lemma (e.g. /qucalc @major @minor)");
      sys("  //message        — send a message starting with /");
      break;

    case "id": {
      if (!qpeer) { sys("not connected"); break; }
      const id = qpeer.peerId;
      const tw = tokenTwists(id);
      if (tw) {
        const { pos, neg, gap, balanced } = twistStats(tw);
        sys(`peer ID: ${id}`);
        sys(`  twists: ${tw.length}  (${pos} positive, ${neg} negative)`);
        sys(`  ZFA-balanced: ${balanced ? "✓" : "✗"}  spectral gap: ${gap}`);
        sys(`  rho_process_always_zfa: ✓ (Lean-verified)`);
      } else {
        sys(`peer ID: ${id}`);
      }
      break;
    }

    case "room": {
      const room = getRoomId();
      const tw = tokenTwists(room);
      sys(`room: ${room}`);
      if (tw) {
        const { pos, neg, gap, balanced } = twistStats(tw);
        sys(`  twists: ${tw.length}  (${pos} pos, ${neg} neg)  gap: ${gap}  ZFA: ${balanced ? "✓" : "✗"}`);
      }
      break;
    }

    case "cap": {
      const label = arg || "cap";
      const token = generateCapability(label);
      const tw = tokenTwists(token)!;
      const { pos, neg } = twistStats(tw);
      sys(`generated: ${token}`);
      sys(`  twists: ${tw.length}  (${pos} pos, ${neg} neg)  ZFA-balanced: ✓`);
      break;
    }

    case "grant": {
      const label = arg || "cap";
      const token = generateCapability(label);
      const tw = tokenTwists(token)!;
      const { pos, neg } = twistStats(tw);
      const grantWho = myName || (qpeer ? shortId(qpeer.peerId) : "local");
      lemmaStore.set(label, { twists: token, who: grantWho, cap: token });
      saveLemmas();
      renderLemmas();
      sys(`granted: ${token}`);
      sys(`  twists: ${tw.length}  (${pos} pos, ${neg} neg)  ZFA-balanced: ✓`);
      sys(`  registered as @${label} — use /pass ${label} <peer> to transfer`);
      if (qpeer) qpeer.broadcast({ kind: "cap-grant", token, label });
      break;
    }

    case "lemma": {
      if (!arg) {
        if (lemmaStore.size === 0) {
          sys("no lemmas registered yet");
          sys("  usage: /lemma <name> <twists|@ref1 @ref2|cap:token>");
        } else {
          sys(`lemmas (${lemmaStore.size}):`);
          for (const [name, entry] of lemmaStore) {
            sys(`  @${name}  =  ${entry.twists}${entry.cap ? `  [cap: ${entry.cap}]` : ""}  (by ${entry.who})`);
          }
        }
        break;
      }
      const lemmaParts = arg.trim().split(/\s+/);
      const lemmaName = lemmaParts[0];
      const lemmaTwistsArg = lemmaParts.slice(1).join(" ").trim();
      if (!lemmaName) {
        sys("usage: /lemma <name> [twists|@ref1 @ref2|cap:token]");
        sys("  omit twists to auto-allocate from the name");
        break;
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(lemmaName)) {
        sys(`invalid lemma name: '${lemmaName}'  (use letters, digits, _ or -)`);
        break;
      }
      const isAutoAlloc = !lemmaTwistsArg;
      let resolvedTwistsStr: string;
      if (isAutoAlloc) {
        resolvedTwistsStr = twistsToSymbolic(allocateTwists(lemmaName));
      } else if (lemmaTwistsArg.includes("@")) {
        const result = expandLemmaRefs(lemmaTwistsArg);
        if (!result) {
          const badName = lemmaTwistsArg.split(/\s+/).find(t => t.startsWith("@") && !lemmaStore.has(t.slice(1)));
          sys(`unknown lemma reference: ${badName ?? "@?"}`);
          break;
        }
        resolvedTwistsStr = result.expanded;
      } else {
        resolvedTwistsStr = lemmaTwistsArg;
      }
      const checkTw = resolveLemmaToBytes(resolvedTwistsStr);
      if (!checkTw || checkTw.length === 0) {
        sys(`cannot parse twists: '${resolvedTwistsStr}'`);
        sys("  valid: symbolic (^v<>/\\\\+-), hex digits 0-7, or cap:label:hex");
        break;
      }
      const { pos: lPos, neg: lNeg, balanced: lBal } = twistStats(checkTw);
      const lemWho = myName || (qpeer ? shortId(qpeer.peerId) : "local");
      const lemCap = lBal ? lemmaToCapToken(lemmaName, checkTw) : undefined;
      lemmaStore.set(lemmaName, { twists: resolvedTwistsStr, who: lemWho, cap: lemCap });
      sys(`lemma registered: @${lemmaName}  =  ${resolvedTwistsStr}${isAutoAlloc ? "  (auto-allocated)" : ""}`);
      sys(`  twists: ${checkTw.length}  (${lPos}+/${lNeg}-)  ZFA: ${lBal ? "✓" : "✗"}`);
      if (lemCap) sys(`  cap: ${lemCap}  (share with /zfa to verify)`);
      if (qpeer) qpeer.broadcast({ kind: "lemma", name: lemmaName, twists: resolvedTwistsStr, cap: lemCap, who: lemWho });
      saveLemmas();
      renderLemmas();
      break;
    }

    case "zfa": {
      const token = arg.trim();
      if (!token) { sys("usage: /zfa <capability-token>"); break; }
      const valid = validateCapability(token);
      const tw = tokenTwists(token);
      sys(`token: ${token}`);
      if (tw) {
        const { pos, neg, gap } = twistStats(tw);
        sys(`  valid: ${valid ? "✓" : "✗"}  spectral gap: ${gap}`);
        sys(`  twists: ${tw.length}  (${pos} positive, ${neg} negative)`);
      } else {
        sys(`  not a capability token (expected cap:label:hex)`);
      }
      break;
    }

    case "braket": {
      if (!arg) {
        sys("usage: /braket <state> [state ...]");
        sys("  states: 0  1  +  -  i  -i  (space-separated = superposition)");
        sys("  examples: /braket 0   /braket + -   /braket -i");
        break;
      }
      const rawToks = arg.trim().split(/\s+/);
      const parsed: string[] = [];
      for (let k = 0; k < rawToks.length; k++) {
        if (rawToks[k] === "-" && k + 1 < rawToks.length && rawToks[k + 1] === "i") {
          parsed.push("-i"); k++;
        } else {
          parsed.push(rawToks[k]);
        }
      }
      const unknown = parsed.find(s => !(s in STATE_FORMS));
      if (unknown) { sys(`unknown state: '${unknown}'  (valid: 0 1 + - i -i)`); break; }
      let mat = formToMatrix(STATE_FORMS[parsed[0]]);
      for (let k = 1; k < parsed.length; k++) mat = addM(mat, formToMatrix(STATE_FORMS[parsed[k]]));
      const ketLabel = parsed.map(s => STATE_KET[s]).join(" + ");
      const braLabel = parsed.map(s => STATE_BRA[s]).join(" + ");
      const procLabel = parsed.length > 1
        ? `parallel(${parsed.map(s => `action(Form_${s})`).join(", ")})`
        : `action(Form_${parsed[0]})`;
      sys(`ket: ${ketLabel}`);
      sys(`  RhoProcess: ${procLabel}`);
      sys("  eval = Form.toMatrix:");
      for (const line of fmtMatrix(mat)) sys(line);
      sys(`bra: ${braLabel}  (eval = ket†  =  ket  [Hermitian: Form.toMatrix_adjoint ✓])`);
      sys("  ZFA: action [+,−]  lift [−,+]  both balanced: ✓");
      sys("  bra_ket_always_balanced: ✓ (BraKetRhoQuCalc.lean)");
      break;
    }

    case "qucalc": {
      let qtwists: Uint8Array | null = null;
      let srcLabel = "";
      let components: Array<{ label: string | null; twists: string }> | null = null;
      if (!arg) {
        const id = qpeer?.peerId ?? null;
        if (!id) { sys("not connected (no peer ID); or pass twists as argument"); break; }
        qtwists = tokenTwists(id);
        srcLabel = `peer: ${id}`;
      } else if (arg.trim().includes("@")) {
        const result = expandLemmaRefs(arg.trim());
        if (!result) {
          const badName = arg.trim().split(/\s+/).find(t => t.startsWith("@") && !lemmaStore.has(t.slice(1)));
          sys(`unknown lemma: ${badName ?? "@?"}  (type /lemma to list)`);
          break;
        }
        qtwists = parseSymbolicTwists(result.expanded);
        components = result.components;
        srcLabel = `composed: ${arg.trim()}`;
      } else if (arg.trim().startsWith("cap:")) {
        qtwists = tokenTwists(arg.trim());
        srcLabel = `token: ${arg.trim()}`;
      } else {
        qtwists = parseSymbolicTwists(arg.trim());
        srcLabel = `input: ${arg.trim()}`;
      }
      if (!qtwists || qtwists.length === 0) {
        sys("usage: /qucalc [twists]");
        sys("  twists: symbolic (^v<>/\\+-) or hex digits 0-7 or cap:label:hex");
        sys("  examples: /qucalc +-+-+-+-   /qucalc ^v^v   /qucalc cap:peer:…");
        sys("  @name:   /qucalc @major @minor   (use named lemmas, see /lemma)");
        sys("  (no arg: show your peer as a RhoQuCalc process)");
        break;
      }
      const { pos, neg, gap, balanced } = twistStats(qtwists);
      const symbolic = twistsToSymbolic(qtwists);
      sys("RhoQuCalc process:");
      sys(`  ${srcLabel}`);
      if (components && components.filter(c => c.label !== null).length > 1) {
        sys("  deduction composition:");
        for (const c of components) {
          const tw = parseSymbolicTwists(c.twists);
          if (!tw) continue;
          const s = twistStats(tw);
          const lbl = c.label ? `@${c.label}` : `(${c.twists})`;
          sys(`    ${lbl}  →  ${c.twists}  (${s.pos}+/${s.neg}-)  ZFA: ${s.balanced ? "✓" : "✗"}`);
        }
        sys(`  composed: ${symbolic}  (${qtwists.length} total)`);
      } else {
        sys(`  twists: ${symbolic}  (${qtwists.length} total)`);
      }
      sys(`  action (pos): count=${pos}   lift (neg): count=${neg}`);
      sys(`  spectral gap: ${gap}  ZFA-balanced: ${balanced ? "✓" : "✗"}`);
      if (balanced) {
        const freqN = zfaFreqLevel(qtwists);
        if (freqN !== null) {
          const mult = zfaMultiplicity(freqN);
          sys(`  frequency level: ${freqN}  C(${qtwists.length},${freqN}) = ${mult.toLocaleString()} arrangements`);
          sys(`  relative frequency: ${freqN === 1 ? "fundamental (highest)" : `×1/2^${freqN-1} of fundamental`}`);
        }
        sys("  process: parallel(action(Form), lift(Form))  → ZFA stable");
        sys("  achieves_ZFA: ✓  stable under full_zeno_prune");
        sys("  rho_process_always_zfa: ✓ (Lean-verified)");
      } else {
        sys("  process: UNBALANCED  → pruned by full_zeno_prune");
        sys(`  achieves_ZFA: ✗  gap=${gap}  (not a physical process)`);
      }
      break;
    }

    case "dump": {
      if (sessionLog.length === 0) { sys("no logic shared yet this session"); break; }
      sys("logic shared this session:");
      for (const e of sessionLog) {
        const argPart = e.arg ? ` ${e.arg}` : "";
        sys(`  ${e.who}: /${e.cmd}${argPart}`);
        if (e.summary) sys(`    → ${e.summary}`);
      }
      break;
    }

    case "freq": {
      let highlight: number | null = null;
      if (!arg && qpeer) {
        const tw = tokenTwists(qpeer.peerId);
        if (tw) highlight = zfaFreqLevel(tw);
      } else if (arg) {
        const trimmed = arg.trim();
        if (/^\d+$/.test(trimmed)) {
          highlight = parseInt(trimmed, 10);
        } else if (trimmed.startsWith("cap:")) {
          const tw = tokenTwists(trimmed);
          if (tw) highlight = zfaFreqLevel(tw);
        } else {
          const tw = parseSymbolicTwists(trimmed);
          if (tw) {
            if (!achievesZfa(tw)) { sys("not ZFA-balanced — frequency level undefined"); break; }
            highlight = zfaFreqLevel(tw);
          }
        }
      }
      sys("ZFA frequency spectrum:");
      sys("  level n = length 2n  |  C(2n,n) arrangements  |  relative frequency");
      sys("  each level resolves 2× before the next (2:1 harmonic)");
      sys("");
      for (let i = 1; i <= Math.max(10, highlight ?? 0) && i <= 10; i++) {
        const mult = zfaMultiplicity(i);
        const freqStr = (i === 1 ? "×1" : `×1/2^${i-1}`).padEnd(8);
        const bar = "█".repeat(Math.max(1, Math.round(Math.log2(mult + 1))));
        const marker = i === highlight ? "  ← you" : "";
        sys(`  n=${String(i).padEnd(2)} len=${String(2*i).padEnd(3)} C(${2*i},${i})=${String(mult).padStart(12)}  ${freqStr} ${bar}${marker}`);
      }
      if (highlight !== null && highlight > 10) {
        sys("  ...");
        const mult = zfaMultiplicity(highlight);
        sys(`  n=${highlight} len=${2*highlight} C(${2*highlight},${highlight})=${mult.toLocaleString()}  ×1/2^${highlight-1}  ← you`);
      }
      sys("");
      sys("  C(2n,n) ~ 4^n/√(πn)  proven: QLF_Riemann.find_stable_states_length_even");
      break;
    }

    case "request": {
      const lemmaName = arg.trim();
      if (!lemmaName) { sys("usage: /request <lemma-name>"); break; }
      if (!qpeer) { sys("not connected"); break; }
      if (lemmaStore.has(lemmaName)) { sys(`you already hold @${lemmaName}`); break; }
      const myLabel = myName || shortId(qpeer.peerId);
      qpeer.broadcast({ kind: "lemma-request", name: lemmaName, fromName: myLabel });
      sys(`· requested @${lemmaName} — waiting for holder to /pass it`);
      break;
    }

    case "pass": {
      const passParts = arg.trim().split(/\s+/);
      const passLemma = passParts[0];
      const targetName = passParts.slice(1).join(" ").trim();
      if (!passLemma || !targetName) { sys("usage: /pass <lemma-name> <peer-name>"); break; }
      if (!qpeer) { sys("not connected"); break; }
      const passEntry = lemmaStore.get(passLemma);
      if (!passEntry) { sys(`you don't hold @${passLemma} — nothing to pass`); break; }
      const targetId = findPeerByName(targetName);
      if (!targetId) { sys(`unknown peer: '${targetName}'  (check Peers list for exact name)`); break; }
      const sent = qpeer.send(targetId, { kind: "lemma-pass", name: passLemma, twists: passEntry.twists, cap: passEntry.cap });
      if (!sent) { sys(`cannot reach ${targetName} — data channel not open`); break; }
      lemmaStore.delete(passLemma);
      saveLemmas();
      renderLemmas();
      sys(`· @${passLemma} transferred to ${targetName} — removed from your lemmas`);
      if (passEntry.cap) sys(`  cap: ${passEntry.cap}`);
      break;
    }

    case "note": {
      const nParts = arg.trim().split(/\s+/);
      const sub = (nParts[0] || "").toLowerCase();
      const a1 = nParts[1] ?? "";
      const a2 = nParts[2] ?? "";
      const aRest = nParts.slice(2).join(" ").trim();

      // Helper: pick a held note of `currency` with denomination ≥ N (prefer exact match).
      const pickNote = (currency: string, N: number): NoteEntry | null => {
        let exact: NoteEntry | null = null;
        let larger: NoteEntry | null = null;
        for (const n of noteStore.values()) {
          if (n.currency !== currency) continue;
          if (n.denomination === N) { exact = n; break; }
          if (n.denomination > N && (!larger || n.denomination < larger.denomination)) larger = n;
        }
        return exact ?? larger;
      };

      // Helper: detach a denomination-N piece from a held note. Returns the
      // outgoing token and (if split) the change note already re-registered.
      // Always undoable by re-adding `chosen` and removing `change`.
      const detach = (chosen: NoteEntry, N: number): { outgoing: string; change: NoteEntry | null } | null => {
        if (chosen.denomination === N) {
          noteStore.delete(chosen.token);
          return { outgoing: chosen.token, change: null };
        }
        const split = splitNote(chosen.token, N);
        if (!split) return null;
        const [paid, changeTok] = split;
        const change: NoteEntry = { token: changeTok, currency: chosen.currency, denomination: chosen.denomination - N };
        noteStore.delete(chosen.token);
        noteStore.set(changeTok, change);
        return { outgoing: paid, change };
      };

      const undoDetach = (chosen: NoteEntry, change: NoteEntry | null) => {
        if (change) noteStore.delete(change.token);
        noteStore.set(chosen.token, chosen);
      };

      switch (sub) {
        case "":
        case "list": {
          if (currencyTokens.size === 0 && noteStore.size === 0 && receiptStore.size === 0) {
            sys("no notes, currencies, or receipts in this room");
            sys("  /note declare <currency>            — issue a new currency");
            sys("  /note grant <currency> <N>          — mint a denomination-N note");
            sys("  /note pass <currency> <N> <peer>    — transfer to a peer (auto-splits)");
            sys("  /note redeem <currency> <N> <peer>  — redeem with issuer, get receipt");
            sys("  /note split <token> <a>             — split into (a, N-a)");
            sys("  /note merge <token1> <token2>       — combine two notes");
            sys("  /note balance [currency]            — sum denominations");
            break;
          }
          if (currencyTokens.size > 0) {
            sys(`currency authorities (${currencyTokens.size}):`);
            for (const [cur, tok] of currencyTokens) sys(`  ${cur}  ${tok}`);
          }
          if (noteStore.size > 0) {
            sys(`notes you hold (${noteStore.size}):`);
            for (const n of noteStore.values()) {
              const from = n.receivedFrom ? `  (from ${n.receivedFrom})` : "";
              sys(`  ${n.currency} ${n.denomination}${from}`);
              sys(`    ${n.token}`);
            }
          }
          if (receiptStore.size > 0) {
            sys(`receipts (${receiptStore.size}):`);
            for (const r of receiptStore.values()) {
              sys(`  ${r.currency} ${r.denomination}  honored by ${r.issuer}`);
              sys(`    ${r.token}`);
            }
          }
          if (redemptionsHonored.size > 0) {
            sys(`redemptions you honored (${redemptionsHonored.size}):`);
            for (const r of redemptionsHonored.values()) {
              sys(`  ${r.currency} ${r.denomination}  for ${r.redeemer}`);
            }
          }
          break;
        }

        case "balance": {
          const want = a1;
          const sums = new Map<string, number>();
          for (const n of noteStore.values()) {
            if (want && n.currency !== want) continue;
            sums.set(n.currency, (sums.get(n.currency) ?? 0) + n.denomination);
          }
          if (sums.size === 0) { sys(want ? `no ${want} notes` : "no notes"); break; }
          sys("balances:");
          for (const [cur, sum] of sums) sys(`  ${cur}: ${sum}`);
          break;
        }

        case "declare": {
          const currency = a1;
          if (!currency || !/^[A-Za-z0-9_]+$/.test(currency)) {
            sys("usage: /note declare <currency>   (currency: letters, digits, _)");
            break;
          }
          if (currencyTokens.has(currency)) {
            sys(`you already issue ${currency}: ${currencyTokens.get(currency)}`);
            break;
          }
          const token = mintCurrencyToken(currency);
          currencyTokens.set(currency, token);
          const who = myName || (qpeer ? shortId(qpeer.peerId) : "local");
          knownCurrencies.set(token, { currency, token, issuer: who });
          saveNotes();
          renderNotes();
          sys(`declared currency: ${currency}`);
          sys(`  authority: ${token}`);
          sys(`  you can now /note grant ${currency} <N>`);
          if (qpeer) qpeer.broadcast({ kind: "note-declare", currency, token, who });
          break;
        }

        case "grant": {
          const currency = a1;
          const N = parseInt(a2, 10);
          if (!currency || isNaN(N) || N < 1) {
            sys("usage: /note grant <currency> <N>");
            break;
          }
          if (!currencyTokens.has(currency)) {
            sys(`you don't hold cap:token-${currency}: declare it first with /note declare ${currency}`);
            break;
          }
          const note = mintNote(currency, N);
          noteStore.set(note, { token: note, currency, denomination: N });
          saveNotes();
          renderNotes();
          const who = myName || (qpeer ? shortId(qpeer.peerId) : "local");
          sys(`minted: ${currency} ${N}`);
          sys(`  ${note}`);
          if (qpeer) qpeer.broadcast({ kind: "note-grant", currency, denomination: N, who });
          break;
        }

        case "pass": {
          const currency = a1;
          const N = parseInt(a2, 10);
          const targetName = nParts.slice(3).join(" ").trim();
          if (!currency || isNaN(N) || N < 1 || !targetName) {
            sys("usage: /note pass <currency> <N> <peer-name>");
            break;
          }
          if (!qpeer) { sys("not connected"); break; }
          const chosen = pickNote(currency, N);
          if (!chosen) { sys(`no ${currency} note of denomination ≥ ${N}`); break; }
          const targetId = findPeerByName(targetName);
          if (!targetId) { sys(`unknown peer: '${targetName}'`); break; }
          const detached = detach(chosen, N);
          if (!detached) { sys("split failed"); break; }
          const sent = qpeer.send(targetId, { kind: "note-pass", currency, denomination: N, token: detached.outgoing });
          if (!sent) {
            undoDetach(chosen, detached.change);
            sys(`cannot reach ${targetName} — data channel not open`);
            break;
          }
          saveNotes();
          renderNotes();
          sys(`· ${currency} ${N} → ${targetName}`);
          sys(`  ${detached.outgoing}`);
          if (detached.change) sys(`  (change ${detached.change.denomination} returned to your wallet)`);
          break;
        }

        case "redeem": {
          const currency = a1;
          const N = parseInt(a2, 10);
          const issuerName = nParts.slice(3).join(" ").trim();
          if (!currency || isNaN(N) || N < 1 || !issuerName) {
            sys("usage: /note redeem <currency> <N> <issuer-peer>");
            break;
          }
          if (!qpeer) { sys("not connected"); break; }
          const chosen = pickNote(currency, N);
          if (!chosen) { sys(`no ${currency} note of denomination ≥ ${N} to redeem`); break; }
          const issuerId = findPeerByName(issuerName);
          if (!issuerId) { sys(`unknown peer: '${issuerName}'`); break; }
          const detached = detach(chosen, N);
          if (!detached) { sys("split failed"); break; }
          const sent = qpeer.send(issuerId, { kind: "note-redeem", currency, denomination: N, token: detached.outgoing });
          if (!sent) {
            undoDetach(chosen, detached.change);
            sys(`cannot reach ${issuerName} — data channel not open`);
            break;
          }
          saveNotes();
          renderNotes();
          sys(`· redeemed ${currency} ${N} → ${issuerName}`);
          sys(`  awaiting receipt…`);
          if (detached.change) sys(`  (change ${detached.change.denomination} returned to your wallet)`);
          break;
        }

        case "split": {
          const tokenArg = a1;
          const a = parseInt(a2, 10);
          if (!tokenArg || isNaN(a)) { sys("usage: /note split <token> <a>"); break; }
          const held = noteStore.get(tokenArg);
          if (!held) { sys(`you don't hold that note`); break; }
          const split = splitNote(tokenArg, a);
          if (!split) { sys(`invalid split: a must be 1..${held.denomination - 1}`); break; }
          const [t1, t2] = split;
          noteStore.delete(tokenArg);
          noteStore.set(t1, { token: t1, currency: held.currency, denomination: a });
          noteStore.set(t2, { token: t2, currency: held.currency, denomination: held.denomination - a });
          saveNotes();
          renderNotes();
          sys(`split ${held.currency} ${held.denomination}:`);
          sys(`  ${a}  ${t1}`);
          sys(`  ${held.denomination - a}  ${t2}`);
          break;
        }

        case "merge": {
          const t1Arg = a1;
          const t2Arg = aRest;
          if (!t1Arg || !t2Arg) { sys("usage: /note merge <token1> <token2>"); break; }
          const h1 = noteStore.get(t1Arg);
          const h2 = noteStore.get(t2Arg);
          if (!h1 || !h2) { sys("both tokens must be notes you hold"); break; }
          if (h1.currency !== h2.currency) { sys(`currency mismatch: ${h1.currency} vs ${h2.currency}`); break; }
          const merged = mergeNotes(t1Arg, t2Arg);
          if (!merged) { sys("merge failed"); break; }
          noteStore.delete(t1Arg);
          noteStore.delete(t2Arg);
          noteStore.set(merged, { token: merged, currency: h1.currency, denomination: h1.denomination + h2.denomination });
          saveNotes();
          renderNotes();
          sys(`merged ${h1.currency}: ${h1.denomination} + ${h2.denomination} = ${h1.denomination + h2.denomination}`);
          sys(`  ${merged}`);
          break;
        }

        default:
          sys(`unknown subcommand: /note ${sub}`);
          sys("  /note [list]                        — show held notes / currencies / receipts");
          sys("  /note balance [currency]            — sum denominations");
          sys("  /note declare <currency>            — issue a new currency");
          sys("  /note grant <currency> <N>          — mint a denomination-N note");
          sys("  /note pass <currency> <N> <peer>    — transfer (auto-splits)");
          sys("  /note redeem <currency> <N> <peer>  — redeem with issuer, get receipt");
          sys("  /note split <token> <a>             — split into (a, N-a)");
          sys("  /note merge <token1> <token2>       — combine two notes");
      }
      break;
    }

    default:
      sys(`unknown command: /${cmd}  (type /help for list)`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

function connect(): void {
  if (qpeer) {
    qpeer.disconnect();
    qpeer = null;
    peers.clear();
    peerNames.clear();
    renderPeers();
    msgInput.disabled = true;
    sendBtn.disabled = true;
    connectBtn.textContent = "Connect";
    setStatus("disconnected", "disconnected");
    return;
  }

  const roomId = getRoomId();
  const signalingUrl = signalUrlEl.value.trim();
  const stunUrl = stunUrlEl.value.trim();

  setStatus("connecting", "connecting… (first connect may take ~30s to wake server)");
  connectBtn.textContent = "Disconnect";

  qpeer = new QOSPeer({
    signalingUrl,
    roomId,
    iceServers: stunUrl ? [{ urls: stunUrl }] : undefined,
    onSignalingOpen() {
      setStatus("connected", `connected · ${signalingUrl}`);
      msgInput.disabled = false;
      sendBtn.disabled = false;
      renderPeers();
      toggleSidebar(false);   // free the chat once connected (no-op on desktop)
      addMessage("", `joined room ${shortId(roomId)}`, "system");
    },
    onSignalingClose() {
      setStatus("connecting", "reconnecting…");
      msgInput.disabled = true;
      sendBtn.disabled = true;
    },
    onMessage(from, data) {
      if (typeof data === "object" && data !== null) {
        const d = data as Record<string, unknown>;
        if (d.kind === "name") {
          peerNames.set(from, String(d.name ?? ""));
          renderPeers();
          return;
        }
        if (d.kind === "qlf") {
          const cmdStr = String(d.cmd ?? "");
          const argStr = String(d.arg ?? "");
          const pLines = d.lines as string[];
          addMessage(from, `/${cmdStr}${argStr ? " " + argStr : ""}`, "peer", peerLabel(from));
          for (const line of pLines) addMessage("", line, "system");
          sessionLog.push({ who: peerLabel(from), cmd: cmdStr, arg: argStr, summary: pLines[0] ?? "" });
          return;
        }
        if (d.kind === "cap-grant") {
          const who = peerLabel(from);
          addMessage(from, `/grant ${String(d.label ?? "")}`, "peer", who);
          addMessage("", `  ${String(d.token ?? "")}`, "system");
          addMessage("", `  run /zfa ${String(d.token ?? "")} to verify`, "system");
          return;
        }
        if (d.kind === "lemma") {
          const name = String(d.name ?? "").trim();
          const twists = String(d.twists ?? "").trim();
          const cap = d.cap ? String(d.cap) : undefined;
          const who = peerLabel(from);
          if (name && twists) {
            lemmaStore.set(name, { twists, who, cap });
            addMessage(from, `/lemma ${name} ${twists}`, "peer", who);
            addMessage("", `  @${name} registered from ${who}${cap ? `  [cap: ${cap}]` : ""}`, "system");
            saveLemmas();
            renderLemmas();
          }
          return;
        }
        if (d.kind === "lemma-request") {
          const name = String(d.name ?? "").trim();
          const fromName = String(d.fromName ?? peerLabel(from));
          addMessage(from, `requests @${name}`, "peer", fromName);
          if (lemmaStore.has(name)) {
            addMessage("", `  · you hold @${name} — type /pass ${name} ${fromName} to transfer`, "system");
          }
          return;
        }
        if (d.kind === "lemma-pass") {
          const name = String(d.name ?? "").trim();
          const twists = String(d.twists ?? "").trim();
          const cap = d.cap ? String(d.cap) : undefined;
          const who = peerLabel(from);
          if (name && twists) {
            lemmaStore.set(name, { twists, who, cap });
            saveLemmas();
            renderLemmas();
            addMessage(from, `passes @${name}`, "peer", who);
            addMessage("", `  · @${name} received from ${who}${cap ? `  [cap: ${cap}]` : ""}`, "system");
            if (cap) addMessage("", `  · run /zfa ${cap} to verify`, "system");
          }
          return;
        }
        if (d.kind === "note-declare") {
          const currency = String(d.currency ?? "");
          const token    = String(d.token ?? "");
          const who      = peerLabel(from);
          addMessage(from, `/note declare ${currency}`, "peer", who);
          const parsed = parseNoteLabel(token);
          const valid  = parsed?.kind === "token" && parsed.currency === currency && validateCapability(token);
          if (!valid) {
            addMessage("", `  · refused: malformed currency authority token`, "system");
            return;
          }
          if (!knownCurrencies.has(token)) {
            knownCurrencies.set(token, { currency, token, issuer: who });
            saveNotes();
            renderNotes();
          }
          addMessage("", `  · ${who} issues ${currency}  authority: ${token}`, "system");
          return;
        }
        if (d.kind === "note-grant") {
          const currency = String(d.currency ?? "");
          const N        = Number(d.denomination ?? 0);
          const who      = peerLabel(from);
          addMessage(from, `/note grant ${currency} ${N}`, "peer", who);
          addMessage("", `  · ${who} minted ${currency} ${N}`, "system");
          return;
        }
        if (d.kind === "note-pass") {
          const currency = String(d.currency ?? "");
          const N        = Number(d.denomination ?? 0);
          const token    = String(d.token ?? "");
          const who      = peerLabel(from);
          // Validate format and balance before accepting.
          const parsed = parseNoteLabel(token);
          const valid  = parsed?.kind === "note" && parsed.currency === currency
                       && noteDenomination(token) === N && validateCapability(token);
          if (!valid) {
            addMessage(from, `passes ${currency} ${N}`, "peer", who);
            addMessage("", `  · refused: malformed or unbalanced note token`, "system");
            return;
          }
          noteStore.set(token, { token, currency, denomination: N, receivedFrom: who });
          saveNotes();
          renderNotes();
          addMessage(from, `passes ${currency} ${N}`, "peer", who);
          addMessage("", `  · received ${currency} ${N} from ${who}`, "system");
          addMessage("", `    ${token}`, "system");
          return;
        }
        if (d.kind === "note-redeem") {
          const currency = String(d.currency ?? "");
          const N        = Number(d.denomination ?? 0);
          const token    = String(d.token ?? "");
          const who      = peerLabel(from);
          addMessage(from, `redeems ${currency} ${N}`, "peer", who);
          if (!currencyTokens.has(currency)) {
            addMessage("", `  · refused: you don't issue ${currency}`, "system");
            return;
          }
          const parsed = parseNoteLabel(token);
          const valid  = parsed?.kind === "note" && parsed.currency === currency
                       && noteDenomination(token) === N && validateCapability(token);
          if (!valid) {
            addMessage("", `  · refused: malformed or unbalanced note token`, "system");
            return;
          }
          const receipt = mintReceipt(currency, N);
          const myLabel = myName || (qpeer ? shortId(qpeer.peerId) : "local");
          redemptionsHonored.set(token, { token, currency, denomination: N, redeemer: who, at: Date.now() });
          saveNotes();
          renderNotes();
          const ok = qpeer?.send(from, { kind: "note-receipt", currency, denomination: N, token: receipt, original: token, issuer: myLabel });
          if (!ok) {
            addMessage("", `  · receipt minted but could not deliver — peer unreachable`, "system");
            return;
          }
          addMessage("", `  · honored: ${currency} ${N} for ${who}`, "system");
          addMessage("", `    receipt: ${receipt}`, "system");
          return;
        }
        if (d.kind === "note-receipt") {
          const currency = String(d.currency ?? "");
          const N        = Number(d.denomination ?? 0);
          const token    = String(d.token ?? "");
          const issuer   = String(d.issuer ?? peerLabel(from));
          const parsed = parseNoteLabel(token);
          const valid  = parsed?.kind === "receipt" && parsed.currency === currency
                       && noteDenomination(token) === N && validateCapability(token);
          if (!valid) {
            addMessage(from, `sends receipt`, "peer", issuer);
            addMessage("", `  · refused: malformed receipt token`, "system");
            return;
          }
          receiptStore.set(token, { token, currency, denomination: N, issuer });
          saveNotes();
          renderNotes();
          addMessage(from, `issues receipt for ${currency} ${N}`, "peer", issuer);
          addMessage("", `  · ${currency} ${N} redemption honored by ${issuer}`, "system");
          addMessage("", `    ${token}`, "system");
          return;
        }
        if (d.kind === "sync-lemmas") {
          const raw = d.entries;
          if (!Array.isArray(raw)) return;
          const entries = raw as Array<{ name?: string; twists?: string; who?: string; cap?: string }>;
          const who = peerLabel(from);
          let added = 0;
          for (const e of entries) {
            const name   = String(e.name   ?? "").trim();
            const twists = String(e.twists ?? "").trim();
            if (!name || !twists) continue;
            if (lemmaStore.has(name)) continue;
            const tw = resolveLemmaToBytes(twists);
            if (!tw || !achievesZfa(tw)) continue;
            lemmaStore.set(name, { twists, who: e.who || who, cap: e.cap });
            added++;
          }
          if (added > 0) {
            saveLemmas();
            renderLemmas();
            addMessage(from, `sync`, "peer", who);
            addMessage("", `  · synced ${added} lemma${added === 1 ? "" : "s"} from ${who}`, "system");
          }
          return;
        }
        if (d.kind === "sync-currencies") {
          const raw = d.entries;
          if (!Array.isArray(raw)) return;
          const entries = raw as Array<{ currency?: string; token?: string; issuer?: string }>;
          const who = peerLabel(from);
          let added = 0;
          for (const e of entries) {
            const currency = String(e.currency ?? "").trim();
            const token    = String(e.token    ?? "").trim();
            if (!currency || !token) continue;
            if (knownCurrencies.has(token)) continue;
            const parsed = parseNoteLabel(token);
            if (!parsed || parsed.kind !== "token" || parsed.currency !== currency) continue;
            if (!validateCapability(token)) continue;
            knownCurrencies.set(token, { currency, token, issuer: e.issuer || who });
            added++;
          }
          if (added > 0) {
            saveNotes();
            renderNotes();
            addMessage(from, `sync`, "peer", who);
            addMessage("", `  · synced ${added} currenc${added === 1 ? "y" : "ies"} from ${who}`, "system");
          }
          return;
        }
        if (d.kind === "chat" || "text" in d) {
          const text = "text" in d ? String(d.text) : String(d.message ?? JSON.stringify(d));
          addMessage(from, text, "peer", peerLabel(from));
          return;
        }
      }
      addMessage(from, JSON.stringify(data), "peer", peerLabel(from));
    },
    onChannelOpen(peerId) {
      if (myName) qpeer?.send(peerId, { kind: "name", name: myName });
      // Catch up the new peer with public room state. Held notes / receipts
      // / redemption logs stay private; only the room-knowledge stores ship.
      if (lemmaStore.size > 0) {
        const entries = Array.from(lemmaStore.entries()).map(([name, e]) => ({
          name, twists: e.twists, who: e.who, cap: e.cap,
        }));
        qpeer?.send(peerId, { kind: "sync-lemmas", entries });
      }
      if (knownCurrencies.size > 0) {
        const entries = Array.from(knownCurrencies.values());
        qpeer?.send(peerId, { kind: "sync-currencies", entries });
      }
    },
    onPeerJoined(id) {
      const pending = pendingLeaves.get(id);
      if (pending !== undefined) {
        // Signaling blip — peer reconnected before the leave timer fired; suppress both.
        clearTimeout(pending);
        pendingLeaves.delete(id);
        peers.add(id);
        renderPeers();
        return;
      }
      if (peers.has(id)) return;   // already known (e.g. duplicate signal on reconnect)
      peers.add(id);
      renderPeers();
      addMessage("", `${peerLabel(id)} joined`, "system");
    },
    onPeerLeft(id) {
      // Delay the visual/state update so a fast signaling reconnect suppresses the noise.
      const timer = setTimeout(() => {
        pendingLeaves.delete(id);
        peers.delete(id);
        renderPeers();
        addMessage("", `${peerLabel(id)} left`, "system");
        peerNames.delete(id);
      }, 6_000);
      pendingLeaves.set(id, timer);
    },
  });

  qpeer.connect();
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

function send(): void {
  const text = msgInput.value.trim();
  if (!text || !qpeer) return;
  msgInput.value = "";
  if (text.startsWith("//")) {
    const escaped = text.slice(1);
    qpeer.broadcast({ kind: "chat", text: escaped });
    addMessage("", escaped, "self");
    return;
  }
  if (text.startsWith("/")) {
    const parts = text.slice(1).trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ");
    addMessage("", text, "self");
    const lines = handleCommand(text);
    if (cmd !== "help" && cmd !== "dump") {
      sessionLog.push({ who: myName || "you", cmd, arg, summary: lines[0] ?? "" });
    }
    if (lines.length > 0 && cmd !== "help" && cmd !== "grant" && cmd !== "lemma" && cmd !== "note") {
      qpeer.broadcast({ kind: "qlf", cmd, arg, lines });
    }
    return;
  }
  qpeer.broadcast({ kind: "chat", text });
  addMessage("", text, "self");
}

// ---------------------------------------------------------------------------
// Share link
// ---------------------------------------------------------------------------

function updateShareLink(): void {
  const url = window.location.href;
  shareLink.href = url;
  shareLink.textContent = url;
}

copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(window.location.href).then(() => {
    copyBtn.textContent = "copied!";
    setTimeout(() => { copyBtn.textContent = "copy"; }, 1500);
  });
});

function toggleSidebar(open?: boolean): void {
  const isOpen = open ?? !sidebarEl.classList.contains("open");
  sidebarEl.classList.toggle("open", isOpen);
  overlayEl.classList.toggle("open", isOpen);
}
toggleBtn.addEventListener("click", () => toggleSidebar());
overlayEl.addEventListener("click", () => toggleSidebar(false));

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  const roomId = getRoomId();
  roomIdEl.textContent = roomId;
  updateShareLink();

  // Restore saved name
  myNameEl.value = myName;
  myNameEl.addEventListener("input", () => {
    myName = myNameEl.value.trim();
    localStorage.setItem("qos-name", myName);
    renderPeers();
    if (qpeer) qpeer.broadcast({ kind: "name", name: myName });
  });

  await loadZfa();
  loadLemmas();
  loadNotes();

  const cap = generateCapability("peer");
  myIdEl.textContent = cap;

  connectBtn.addEventListener("click", connect);
  sendBtn.addEventListener("click", send);
  msgInput.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

  const qp = new URLSearchParams(window.location.search);
  const sig = qp.get("signal");
  if (sig) signalUrlEl.value = sig;
  else signalUrlEl.value = DEFAULT_SIGNAL;

  // Keep the sidebar visible on narrow screens until the user connects, so
  // the Connect button is reachable without finding the hamburger toggle.
  toggleSidebar(true);

  handleCommand("/help");
}

init();
