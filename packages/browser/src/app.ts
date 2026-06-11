import { loadZfa, generateCapability, validateCapability,
         spectralGap, achievesZfa } from "./zfa.js";
import { QOSPeer } from "./peer.js";
import { parseNoteLabel, denomination as noteDenomination,
         mintCurrencyToken, mintNote, mintReceipt,
         splitNote, mergeNotes } from "./notes.js";
import { newProposalId, conservationCheck,
         uniqueParticipants, shortRdvId, cyclicSwap,
         type Proposal, type Row, type CommitRow } from "./rendezvous.js";
import { newDynCapState, signEnvelope, verifyEnvelope,
         serializeState, deserializeState, serializeChain, deserializeChain,
         type DynCapState, type ChainEntry, type DyncapField, type VerifyResult } from "./dyncap.js";
import { findDiscrepancies, losingPeersIn, normalizeValue,
         SAMPLE_SIZE, PROBE_WINDOW_MS,
         type Observation } from "./probe.js";
import { transpile as rhoquTranspile, RhoQuError, type RhoQuContext, type OnHandler as RhoQuOnHandler } from "./rhoqu.js";
import { tally, liveCounts, summarizeWinners, optionId, sortedOptions,
         type Poll, type PollMethod, type PollOption } from "./polls.js";

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
const pollListEl      = document.getElementById("poll-list")!;
const pollCountEl     = document.getElementById("poll-count")!;
const tabListEl       = document.getElementById("tab-list")!;
const tabAddBtn       = document.getElementById("tab-add") as HTMLButtonElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Cross-room (per-device) state — same across every joined room.
let myName: string = localStorage.getItem("qos-name") ?? "";
type LogEntry = { who: string; cmd: string; arg: string; summary: string };
const sessionLog: LogEntry[] = [];
let dyncapState: DynCapState | null = null;            // seed + anchor + per-room seqs
let signQueue: Promise<void> = Promise.resolve();      // serializes outbound signing

// Per-room types.
interface LemmaEntry { twists: string; who: string; cap?: string; dyncap?: DyncapField }
interface NoteEntry { token: string; currency: string; denomination: number; receivedFrom?: string }
interface ReceiptEntry { token: string; currency: string; denomination: number; issuer: string }
interface RedemptionRecord { token: string; currency: string; denomination: number; redeemer: string; at: number }
interface KnownCurrency { currency: string; token: string; issuer: string; dyncap?: DyncapField }
interface LockedNote extends NoteEntry { proposalId: string; lockedAt: number }
type ProposalRole = "proposer" | "participant";
type ProposalStatus = "pending" | "accepted" | "rejected";
interface ProposalState {
  proposal: Proposal;
  role: ProposalRole;
  myStatus: ProposalStatus;
  acceptedBy: Map<string, string>;
}
interface ProbeWindow {
  open: boolean;
  observations: Observation[];
  contributors: Set<string>;
  timer: number | null;
}

// Per-room chat history so tab switching can replay the messages area.
type ChatKind = "peer" | "self" | "system";
type MediaKind = "image" | "audio" | "video" | "file";
interface MediaAttachment { mediaKind: MediaKind; name: string; mime: string; size: number; url: string }
interface ChatLine { from: string; text: string; kind: ChatKind; label?: string; media?: MediaAttachment; pollId?: string }

// A persist request is an offer from another peer asking us to also store
// their lemma / currency declaration so the room's public state has more
// than one copy and survives any one peer leaving. Acceptance is explicit.
type PersistKind = "lemma" | "currency";
interface PersistRequest {
  id: string;
  kind: PersistKind;
  fromPeer: string;          // peerId of the asker
  fromName: string;          // display label for chat
  // Inline payload for the kind:
  lemmaName?: string;
  lemmaEntry?: LemmaEntry;
  currencyToken?: string;
  currencyEntry?: KnownCurrency;
}

const RDV_TIMEOUT_MS = 60_000;

// Each room is its own Markov blanket — independent state, independent
// dyncap chain trajectory (seqs tracked in dyncapState.seqByRoom), independent
// signaling/data-channel connection. RoomContext holds everything per-room.
interface RoomContext {
  roomId: string;
  qpeer: QOSPeer | null;
  // Peers + transport
  peers: Set<string>;
  peerNames: Map<string, string>;
  pendingLeaves: Map<string, ReturnType<typeof setTimeout>>;
  // Lemma + note stores (the public room knowledge)
  lemmaStore: Map<string, LemmaEntry>;
  currencyTokens: Map<string, string>;
  noteStore: Map<string, NoteEntry>;
  receiptStore: Map<string, ReceiptEntry>;
  redemptionsHonored: Map<string, RedemptionRecord>;
  knownCurrencies: Map<string, KnownCurrency>;
  // Rendezvous
  lockedNotes: Map<string, LockedNote>;
  proposals: Map<string, ProposalState>;
  proposalTimers: Map<string, number>;
  // Dyncap chain state (receiver-side TOFU)
  dyncapChains: Map<string, ChainEntry>;
  // Discrepancy probe + losing-peers ignore set
  probe: ProbeWindow;
  ignoredForSync: Set<string>;
  // Channels this peer is subscribed to in this room — inbound channel-msg
  // envelopes on a subscribed name surface in chat; others are silently dropped.
  channelSubscriptions: Set<string>;
  // Inbound persist requests awaiting accept/reject. Each is a pending offer
  // from another peer asking us to also hold their state for cross-session
  // redundancy.
  pendingPersistRequests: Map<string, PersistRequest>;
  // RhoQu `on channel(x) { … }` handlers — fired when channel-msg envelopes
  // arrive on a matching channel name. Persisted in-memory only.
  rhoquHandlers: RhoQuOnHandler[];
  // Polls: pollId -> Poll (persisted); live card DOM nodes (in-memory only).
  pollStore: Map<string, Poll>;
  pollCards: Map<string, HTMLElement>;
  // Chat history for this room (replayed on tab switch)
  chatLog: ChatLine[];
  // Persisted user-set name for this room's signaling connection (UI only)
  signalingUrl: string;
  // True if there's been activity since the user last viewed this tab.
  hasUnread: boolean;
  // True after the first successful signaling open for this room. Subsequent
  // reopens (reconnects) are silent so a flapping socket doesn't spam the log.
  hasJoinedOnce: boolean;
}

function createRoom(roomId: string): RoomContext {
  return {
    roomId,
    qpeer: null,
    peers: new Set(),
    peerNames: new Map(),
    pendingLeaves: new Map(),
    lemmaStore: new Map(),
    currencyTokens: new Map(),
    noteStore: new Map(),
    receiptStore: new Map(),
    redemptionsHonored: new Map(),
    knownCurrencies: new Map(),
    lockedNotes: new Map(),
    proposals: new Map(),
    proposalTimers: new Map(),
    dyncapChains: new Map(),
    probe: { open: false, observations: [], contributors: new Set(), timer: null },
    ignoredForSync: new Set(),
    channelSubscriptions: new Set(),
    pendingPersistRequests: new Map(),
    rhoquHandlers: [],
    pollStore: new Map(),
    pollCards: new Map(),
    chatLog: loadChat(roomId),
    signalingUrl: DEFAULT_SIGNAL,
    hasUnread: false,
    hasJoinedOnce: false,
  };
}

const rooms = new Map<string, RoomContext>();   // roomId → context (all joined rooms)
// `activeRoom` is the room whose state is currently aliased into the module-
// level let bindings (lemmaStore, peers, …). It is set by setActiveRoom and
// temporarily swapped by inbound callbacks to point at the room that owns
// that callback's QOSPeer — so state mutations land in the right room even
// when the user is looking at a different tab.
let activeRoom!: RoomContext;
// `uiActiveRoom` is the tab the user is currently *looking at*. It only
// changes on switchToRoom. DOM-touching code checks `activeRoom ===
// uiActiveRoom` before painting; otherwise the active room is being mutated
// by a background callback and the user's screen should not flicker.
let uiActiveRoom!: RoomContext;

function isUiActive(): boolean { return activeRoom === uiActiveRoom; }

function markUnread(ctx: RoomContext): void {
  if (ctx === uiActiveRoom) return;
  if (ctx.hasUnread) return;
  ctx.hasUnread = true;
  renderTabs();
}

// Module-level aliases for the active room's state. Existing code paths read
// from these names; they are reassigned on `setActiveRoom` to point at the new
// active room. JavaScript looks up `let` bindings at call time, so all
// references see the active room's data automatically.
let qpeer: QOSPeer | null = null;
let peers: Set<string> = new Set();
let peerNames: Map<string, string> = new Map();
let pendingLeaves: Map<string, ReturnType<typeof setTimeout>> = new Map();
let lemmaStore: Map<string, LemmaEntry> = new Map();
let currencyTokens: Map<string, string> = new Map();
let noteStore: Map<string, NoteEntry> = new Map();
let receiptStore: Map<string, ReceiptEntry> = new Map();
let redemptionsHonored: Map<string, RedemptionRecord> = new Map();
let knownCurrencies: Map<string, KnownCurrency> = new Map();
let lockedNotes: Map<string, LockedNote> = new Map();
let proposals: Map<string, ProposalState> = new Map();
let proposalTimers: Map<string, number> = new Map();
let dyncapChains: Map<string, ChainEntry> = new Map();
let probe: ProbeWindow = { open: false, observations: [], contributors: new Set(), timer: null };
let ignoredForSync: Set<string> = new Set();
let channelSubscriptions: Set<string> = new Set();
let pendingPersistRequests: Map<string, PersistRequest> = new Map();
let rhoquHandlers: RhoQuOnHandler[] = [];
let pollStore: Map<string, Poll> = new Map();
let pollCards: Map<string, HTMLElement> = new Map();

function setActiveRoom(ctx: RoomContext): void {
  activeRoom = ctx;
  if (!rooms.has(ctx.roomId)) rooms.set(ctx.roomId, ctx);
  qpeer              = ctx.qpeer;
  peers              = ctx.peers;
  peerNames          = ctx.peerNames;
  pendingLeaves      = ctx.pendingLeaves;
  lemmaStore         = ctx.lemmaStore;
  currencyTokens     = ctx.currencyTokens;
  noteStore          = ctx.noteStore;
  receiptStore       = ctx.receiptStore;
  redemptionsHonored = ctx.redemptionsHonored;
  knownCurrencies    = ctx.knownCurrencies;
  lockedNotes        = ctx.lockedNotes;
  proposals          = ctx.proposals;
  proposalTimers     = ctx.proposalTimers;
  dyncapChains       = ctx.dyncapChains;
  probe              = ctx.probe;
  ignoredForSync     = ctx.ignoredForSync;
  channelSubscriptions = ctx.channelSubscriptions;
  pendingPersistRequests = ctx.pendingPersistRequests;
  rhoquHandlers = ctx.rhoquHandlers;
  pollStore          = ctx.pollStore;
  pollCards          = ctx.pollCards;
}

// Mutate both the active-room's qpeer and the module-level alias in lockstep.
// Used by connect() / disconnect to keep activeRoom.qpeer consistent.
function setQpeer(p: QOSPeer | null): void {
  qpeer = p;
  activeRoom.qpeer = p;
}

function lemmaToCapToken(name: string, tw: Uint8Array): string {
  // The cap label sits between colons, so slugify spaces out of the name.
  const label = name.trim().replace(/\s+/g, "-");
  return `cap:${label}:${Array.from(tw).map(b => b.toString(16)).join("")}`;
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
  localStorage.setItem(`qos-lemmas-${activeRoom.roomId}`, JSON.stringify(data));
}

function loadLemmas(): void {
  const raw = localStorage.getItem(`qos-lemmas-${activeRoom.roomId}`);
  if (!raw) return;
  try {
    const data = JSON.parse(raw) as Record<string, LemmaEntry>;
    for (const [name, entry] of Object.entries(data)) lemmaStore.set(name, entry);
    renderLemmas();
  } catch { /* ignore corrupt data */ }
}

function savePolls(): void {
  localStorage.setItem(`qos-polls-${activeRoom.roomId}`,
    JSON.stringify(Object.fromEntries(pollStore.entries())));
}

function loadPolls(): void {
  const raw = localStorage.getItem(`qos-polls-${activeRoom.roomId}`);
  if (!raw) return;
  try {
    const data = JSON.parse(raw) as Record<string, Poll>;
    for (const [id, p] of Object.entries(data)) pollStore.set(id, p);
    renderPolls();
  } catch { /* ignore corrupt data */ }
}

function saveNotes(): void {
  const room = activeRoom.roomId;
  localStorage.setItem(`qos-currencies-${room}`,       JSON.stringify(Object.fromEntries(currencyTokens)));
  localStorage.setItem(`qos-notes-${room}`,            JSON.stringify(Object.fromEntries(noteStore)));
  localStorage.setItem(`qos-receipts-${room}`,         JSON.stringify(Object.fromEntries(receiptStore)));
  localStorage.setItem(`qos-redemptions-${room}`,      JSON.stringify(Object.fromEntries(redemptionsHonored)));
  localStorage.setItem(`qos-known-currencies-${room}`, JSON.stringify(Object.fromEntries(knownCurrencies)));
  localStorage.setItem(`qos-locked-notes-${room}`,     JSON.stringify(Object.fromEntries(lockedNotes)));
  localStorage.setItem(`qos-ignored-sync-${room}`,     JSON.stringify(Array.from(ignoredForSync)));
  localStorage.setItem(`qos-channel-subs-${room}`,     JSON.stringify(Array.from(channelSubscriptions)));
}

function saveDyncap(): void {
  if (dyncapState) localStorage.setItem("qos-dyncap-state", serializeState(dyncapState));
  localStorage.setItem(`qos-dyncap-chains-${activeRoom.roomId}`, serializeChain(dyncapChains));
}

async function loadDyncap(): Promise<void> {
  const raw = localStorage.getItem("qos-dyncap-state");
  if (raw) {
    // Pass the active room id so legacy single-seq state migrates cleanly.
    const loaded = await deserializeState(raw, activeRoom.roomId);
    if (loaded) dyncapState = loaded;
  }
  if (!dyncapState) {
    dyncapState = await newDynCapState();
    localStorage.setItem("qos-dyncap-state", serializeState(dyncapState));
  }
}

// Sign-and-broadcast: enqueues the signing so seq order is preserved across
// concurrent outbound envelopes. Falls back to an unsigned send if dyncap
// hasn't been initialized yet (early-init edge cases).
function signedBroadcast(envelope: Record<string, unknown>): void {
  signQueue = signQueue.then(async () => {
    if (!qpeer) return;
    if (!dyncapState) { qpeer.broadcast(envelope); return; }
    const dyncap = await signEnvelope(dyncapState, activeRoom.roomId, envelope);
    saveDyncap();
    qpeer.broadcast({ ...envelope, dyncap });
  }).catch(() => { /* swallow signing errors so the queue keeps moving */ });
}

function signedSend(peerId: string, envelope: Record<string, unknown>): boolean {
  // For direct sends we return synchronously (false if no peer/channel);
  // signing is queued and fires on the same channel.
  if (!qpeer) return false;
  signQueue = signQueue.then(async () => {
    if (!qpeer || !dyncapState) return;
    const dyncap = await signEnvelope(dyncapState, activeRoom.roomId, envelope);
    saveDyncap();
    qpeer.send(peerId, { ...envelope, dyncap });
  }).catch(() => { /* swallow */ });
  return true;
}

/// Verify an inbound envelope's dyncap if present. Returns a status string for
/// chat display (empty when no dyncap was carried). On fork detection, the
/// affected peer is flagged contested and the user is notified.
async function verifyDyncapIfPresent(from: string, d: Record<string, unknown>): Promise<string> {
  const raw = d.dyncap;
  if (!raw || typeof raw !== "object") return "";
  const dyncap = raw as DyncapField;
  const prior = dyncapChains.get(from);
  const result: VerifyResult = await verifyEnvelope(prior, activeRoom.roomId, d, dyncap);
  switch (result.kind) {
    case "ok":
    case "tofu":
      dyncapChains.set(from, result.entry);
      saveDyncap();
      return result.kind === "tofu" ? "  · dyncap anchor pinned (TOFU)" : "";
    case "anchor-mismatch":
      addMessage("", `  ⚠ dyncap anchor mismatch from ${peerLabel(from)}  expected: ${prior?.anchor.slice(0,16)}…  got: ${dyncap.anchor.slice(0,16)}…`, "system");
      return "  · refused: anchor mismatch";
    case "fork": {
      const entry = prior ? { ...prior, contested: true } : prior;
      if (entry) { dyncapChains.set(from, entry); saveDyncap(); }
      addMessage("", `  ⚠ dyncap FORK detected for ${peerLabel(from)} at seq ${result.seq} — identity contested`, "system");
      return "  · refused: fork";
    }
    case "replay":
      return "  · refused: replay";
    case "invalid":
      return `  · refused: invalid dyncap (${result.reason})`;
  }
}

// ---------------------------------------------------------------------------
// Probe window — joiner-local majority resolution of state discrepancies
// ---------------------------------------------------------------------------

function openProbeWindow(): void {
  if (probe.open) return;
  probe = { open: true, observations: [], contributors: new Set(), timer: null };
  probe.timer = setTimeout(closeProbeWindow, PROBE_WINDOW_MS) as unknown as number;
}

function recordSyncObservations(from: string, lemmas: Array<{ name?: string; twists?: string; cap?: string; who?: string }>,
                                currencies: Array<{ currency?: string; token?: string; issuer?: string }>): void {
  if (!probe.open) return;
  if (probe.contributors.size >= SAMPLE_SIZE && !probe.contributors.has(from)) return;
  probe.contributors.add(from);
  // Weight by sender's dyncap chain depth; fresh peers get the minimum.
  const weight = Math.max(1, dyncapChains.get(from)?.lastSeq ?? 1);
  for (const e of lemmas) {
    if (!e.name || !e.twists) continue;
    probe.observations.push({
      storeName: "lemmas",
      key: e.name,
      value: normalizeValue({ twists: e.twists, cap: e.cap ?? null }, []),
      peer: from,
      weight,
    });
  }
  for (const e of currencies) {
    if (!e.currency || !e.token) continue;
    probe.observations.push({
      storeName: "currencies",
      key: e.token,
      value: normalizeValue({ currency: e.currency, issuer: e.issuer ?? null }, []),
      peer: from,
      weight,
    });
  }
  if (probe.contributors.size >= SAMPLE_SIZE) closeProbeWindow();
}

function closeProbeWindow(): void {
  if (!probe.open) return;
  probe.open = false;
  if (probe.timer !== null) { clearTimeout(probe.timer); probe.timer = null; }

  const discrepancies = findDiscrepancies(probe.observations);
  if (discrepancies.length === 0) return;

  let applied = 0;
  for (const d of discrepancies) {
    const leader = d.observations[0];
    const tally = `weight ${leader.weight} vs ${d.observations.slice(1).map(o => o.weight).join(", ")} · ${leader.count} vs ${d.observations.slice(1).map(o => o.count).join(", ")} peers`;
    if (d.winner === null) {
      // No supermajority. Surface the disagreement; do not modify local state.
      signedBroadcast({
        kind: "state-discrepancy",
        storeName: d.storeName,
        key: d.key,
        observations: d.observations,
        winner: null,
        totalWeight: d.totalWeight,
      });
      addMessage("", `⚠ state discrepancy on ${d.storeName}/${d.key} — contested (no supermajority by weight); keeping local value`, "system");
      addMessage("", `  · ${tally}`, "system");
      continue;
    }
    const winner = JSON.parse(d.winner) as Record<string, unknown>;
    if (d.storeName === "lemmas") {
      const existing = lemmaStore.get(d.key);
      const expectedValue = existing ? normalizeValue({ twists: existing.twists, cap: existing.cap ?? null }, []) : null;
      if (expectedValue !== d.winner) {
        lemmaStore.set(d.key, {
          twists: String(winner.twists ?? ""),
          who: existing?.who ?? "(majority)",
          cap: winner.cap === null ? undefined : winner.cap as string | undefined,
          dyncap: existing?.dyncap,
        });
        applied++;
      }
    } else {
      const existing = knownCurrencies.get(d.key);
      const expectedValue = existing ? normalizeValue({ currency: existing.currency, issuer: existing.issuer ?? null }, []) : null;
      if (expectedValue !== d.winner) {
        knownCurrencies.set(d.key, {
          currency: String(winner.currency ?? ""),
          token: d.key,
          issuer: String(winner.issuer ?? "(majority)"),
          dyncap: existing?.dyncap,
        });
        applied++;
      }
    }
    signedBroadcast({
      kind: "state-discrepancy",
      storeName: d.storeName,
      key: d.key,
      observations: d.observations,
      winner: winner,
      totalWeight: d.totalWeight,
    });
    addMessage("", `⚠ state discrepancy on ${d.storeName}/${d.key} — applied majority view (${tally})`, "system");
  }

  // Losing nodes are ignored: their future sync envelopes are dropped.
  const losers = losingPeersIn(discrepancies);
  if (losers.size > 0) {
    for (const peer of losers) {
      ignoredForSync.add(peer);
      addMessage("", `  · ignoring future sync from ${peerLabel(peer)} (losing observer)`, "system");
    }
  }

  if (applied > 0) {
    saveLemmas();
    saveNotes();
    renderLemmas();
    renderNotes();
  } else {
    saveNotes();   // persist ignoredForSync even if no winners changed local state
  }
}

function loadNotes(): void {
  const room = activeRoom.roomId;
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
  // Dyncap chain state (per-room)
  const dynChainRaw = localStorage.getItem(`qos-dyncap-chains-${room}`);
  if (dynChainRaw) {
    for (const [k, v] of deserializeChain(dynChainRaw)) dyncapChains.set(k, v);
  }
  // Ignored-for-sync peers (per-room): peers whose snapshots lost a vote.
  const ignoredRaw = localStorage.getItem(`qos-ignored-sync-${room}`);
  if (ignoredRaw) {
    try {
      const list = JSON.parse(ignoredRaw) as string[];
      if (Array.isArray(list)) for (const p of list) ignoredForSync.add(p);
    } catch { /* ignore */ }
  }
  // Channel subscriptions (per-room).
  const chanRaw = localStorage.getItem(`qos-channel-subs-${room}`);
  if (chanRaw) {
    try {
      const list = JSON.parse(chanRaw) as string[];
      if (Array.isArray(list)) for (const n of list) channelSubscriptions.add(n);
    } catch { /* ignore */ }
  }
  // Locked notes from a previous session are orphans: their proposal state
  // lived in memory only and is gone after reload. Release each back to the
  // wallet so the user doesn't lose value across a refresh.
  const lockedRaw = localStorage.getItem(`qos-locked-notes-${room}`);
  if (lockedRaw) {
    try {
      const data = JSON.parse(lockedRaw) as Record<string, LockedNote>;
      for (const lock of Object.values(data)) {
        noteStore.set(lock.token, {
          token: lock.token,
          currency: lock.currency,
          denomination: lock.denomination,
          receivedFrom: lock.receivedFrom,
        });
      }
      localStorage.removeItem(`qos-locked-notes-${room}`);
    } catch { /* */ }
  }
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
  if (!isUiActive()) return;
  statusDot.className = `status-dot ${state === "disconnected" ? "" : state}`;
  statusText.textContent = label;
  statusText.style.color = state === "connected" ? "#4caf50"
                         : state === "connecting" ? "#ff9800"
                         : "#555";
}

function renderChatLine(line: ChatLine): void {
  const div = document.createElement("div");
  div.className = `msg${line.kind === "system" ? " system-line" : ""}`;
  if (line.pollId) {
    div.className = "msg poll-msg";
    renderPollCardInto(div, line.pollId);
    messagesEl.appendChild(div);
    return;
  }
  const fromEl = document.createElement("span");
  fromEl.className = `from ${line.kind}`;
  fromEl.textContent = line.kind === "system" ? "·"
                     : line.kind === "self"   ? (myName || "you")
                     : (line.label ?? shortId(line.from));
  const textEl = document.createElement("span");
  textEl.className = "text";
  if (line.media) {
    renderMedia(textEl, line.media);
  } else {
    textEl.innerHTML = renderMarkdown(line.text);
  }
  div.appendChild(fromEl);
  div.appendChild(textEl);
  messagesEl.appendChild(div);
}

function addMessage(from: string, text: string, kind: "peer" | "self" | "system" = "peer", label?: string): void {
  const line: ChatLine = { from, text, kind, label };
  activeRoom.chatLog.push(line);
  trimChatLog(activeRoom);
  saveChat(activeRoom);
  if (isUiActive()) {
    renderChatLine(line);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    // Activity in a non-viewed tab — surface it via the tab unread indicator.
    markUnread(activeRoom);
  }
}

// Cap the per-room chat log so long sessions don't grow unbounded.
const CHAT_LOG_MAX = 500;
function trimChatLog(room: RoomContext): void {
  if (room.chatLog.length > CHAT_LOG_MAX) {
    room.chatLog.splice(0, room.chatLog.length - CHAT_LOG_MAX);
  }
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

// ---------------------------------------------------------------------------
// Tabs — multi-room substrate
// ---------------------------------------------------------------------------

function renderTabs(): void {
  tabListEl.innerHTML = "";
  for (const ctx of rooms.values()) {
    const tab = document.createElement("div");
    const isActive = ctx.roomId === uiActiveRoom.roomId;
    tab.className = "tab"
      + (isActive ? " active" : "")
      + (ctx.hasUnread && !isActive ? " unread" : "");
    tab.title = ctx.roomId + (ctx.hasUnread && !isActive ? " (unread)" : "");
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = (ctx.hasUnread && !isActive ? "● " : "") + shortId(ctx.roomId);
    tab.appendChild(label);
    // Only show the close button when there's more than one tab open.
    if (rooms.size > 1) {
      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "Close this room";
      close.addEventListener("click", (e) => { e.stopPropagation(); closeRoomTab(ctx.roomId); });
      tab.appendChild(close);
    }
    tab.addEventListener("click", () => { if (ctx.roomId !== uiActiveRoom.roomId) switchToRoom(ctx.roomId); });
    tabListEl.appendChild(tab);
  }
}

// Switch the active room. Re-renders the whole UI to reflect the new room's
// state. Does NOT disconnect existing connections — each tab keeps its
// per-room qpeer; only the *active* tab's qpeer drives the visible UI.
// (MVP constraint: even though qpeer is per-room in RoomContext, in practice
// only one is connected at a time today.)
function switchToRoom(roomId: string): void {
  const next = rooms.get(roomId);
  if (!next || next.roomId === uiActiveRoom.roomId) return;
  setActiveRoom(next);
  uiActiveRoom = next;
  next.hasUnread = false;        // viewing the room clears the unread flag
  applyActiveRoomToUI();
}

function applyActiveRoomToUI(): void {
  // Sidebar identity / room display
  roomIdEl.textContent = activeRoom.roomId;
  // Signaling URL field reflects this room's last-used URL.
  signalUrlEl.value = activeRoom.signalingUrl;
  // Connect button reflects this room's qpeer state.
  if (qpeer) {
    connectBtn.textContent = "Disconnect";
    setStatus("connected", `connected · ${activeRoom.signalingUrl}`);
    msgInput.disabled = false;
    sendBtn.disabled  = false;
  } else {
    connectBtn.textContent = "Connect";
    setStatus("disconnected", "disconnected");
    msgInput.disabled = true;
    sendBtn.disabled  = true;
  }
  // Chat history replay
  messagesEl.innerHTML = "";
  for (const line of activeRoom.chatLog) renderChatLine(line);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  // Sidebar lists
  renderPeers();
  renderLemmas();
  renderNotes();
  renderPolls();
  // Share link + tab highlight
  updateShareLink();
  renderTabs();
  // Update URL hash to the new active room
  const params = new URLSearchParams(window.location.hash.slice(1));
  params.set("room", activeRoom.roomId);
  history.replaceState(null, "", `#${params.toString()}`);
}

function openRoomTab(roomId: string): void {
  // Idempotent: if already joined, just switch.
  if (rooms.has(roomId)) { switchToRoom(roomId); return; }
  const ctx = createRoom(roomId);
  rooms.set(roomId, ctx);
  // Load per-room persisted state from localStorage into the new context.
  loadRoomState(ctx);
  saveJoinedRooms();
  switchToRoom(roomId);
}

function closeRoomTab(roomId: string): void {
  if (!rooms.has(roomId)) return;
  if (rooms.size <= 1) return;   // never close the last tab
  const ctx = rooms.get(roomId)!;
  // Tear down the connection if any.
  if (ctx.qpeer) { ctx.qpeer.disconnect(); ctx.qpeer = null; }
  rooms.delete(roomId);
  saveJoinedRooms();
  // If we closed the visible one, pick another to activate.
  if (uiActiveRoom.roomId === roomId) {
    const next = rooms.values().next().value as RoomContext;
    setActiveRoom(next);
    uiActiveRoom = next;
    applyActiveRoomToUI();
  } else {
    renderTabs();
  }
}

function saveJoinedRooms(): void {
  const ids = Array.from(rooms.keys());
  localStorage.setItem("qos-joined-rooms", JSON.stringify(ids));
}

function loadJoinedRooms(): string[] {
  const raw = localStorage.getItem("qos-joined-rooms");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

// Populate a RoomContext's stores from per-room localStorage. Re-uses the
// existing load functions, which read via the module-level aliases — so we
// briefly point them at `ctx` for the duration of the load.
function loadRoomState(ctx: RoomContext): void {
  const previousActive = activeRoom;
  setActiveRoom(ctx);
  loadLemmas();
  loadNotes();
  loadPolls();
  if (previousActive) setActiveRoom(previousActive);
}

/// Try to pull a cap:room:… token out of a user-pasted string. Accepts a
/// raw token or a share URL whose hash carries room=cap:room:…
function extractRoomCap(input: string): string | null {
  const s = input.trim();
  if (s.startsWith("cap:room:")) return s;
  const m = s.match(/room=(cap:room:[0-7]+)/);
  return m ? m[1] : null;
}

function promptJoinRoom(): void {
  const input = prompt("Join room — paste a cap:room:… token or a share URL");
  if (!input) return;
  const roomId = extractRoomCap(input);
  if (!roomId) { alert("Couldn't find a cap:room:… token in that input"); return; }
  if (!validateCapability(roomId)) { alert("Invalid room cap (not ZFA-balanced)"); return; }
  openRoomTab(roomId);
}

function renderRoomProcess(): void {
  if (!isUiActive()) return;
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
  if (!isUiActive()) return;
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
  if (!isUiActive()) return;
  lemmaCountEl.textContent = String(lemmaStore.size);
  lemmaListEl.innerHTML = "";
  for (const [name, entry] of lemmaStore) {
    const li = document.createElement("li");
    li.textContent = lemmaRefStr(name);
    li.title = `${entry.twists}${entry.cap ? `  cap: ${entry.cap}` : ""}  (by ${entry.who})`;
    li.style.cursor = "pointer";
    li.addEventListener("click", () => { msgInput.value = `/qucalc ${lemmaRefStr(name)}`; msgInput.focus(); });
    lemmaListEl.appendChild(li);
  }
}

function renderNotes(): void {
  if (!isUiActive()) return;
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

function adjointHistory(tw: Uint8Array): Uint8Array {
  const out = new Uint8Array(tw.length);
  for (let i = 0; i < tw.length; i++) out[i] = tw[tw.length - 1 - i] ^ 1;
  return out;
}

function isSelfAdjoint(tw: Uint8Array): boolean {
  const adj = adjointHistory(tw);
  for (let i = 0; i < tw.length; i++) if (tw[i] !== adj[i]) return false;
  return true;
}

function resolveLemmaToBytes(twistsStr: string): Uint8Array | null {
  if (twistsStr.startsWith("cap:")) return tokenTwists(twistsStr);
  return parseSymbolicTwists(twistsStr);
}

// A lemma name may contain spaces ("all men are mortal"). It is referenced as
// @[name with spaces] (bare @name still works for single-word names) and stored
// under a canonical key: trimmed, with inner whitespace collapsed to one space.
// canonLemma is idempotent and a no-op for single-word names, so applying it at
// every store boundary is safe and leaves existing lemmas unchanged.
function canonLemma(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}
// Reference token for display / input prefill: @name or @[name with spaces].
function lemmaRefStr(name: string): string {
  return /\s/.test(name) ? `@[${name}]` : `@${name}`;
}
// Bare name as a command argument (e.g. after /pass): name or [name with spaces].
function lemmaArgStr(name: string): string {
  return /\s/.test(name) ? `[${name}]` : name;
}

type RefTok = { kind: "ref"; name: string } | { kind: "lit"; text: string };
// Tokenize a command arg into lemma references (@word or @[multi word]) and
// literal twist tokens, preserving order. Multi-word refs survive the
// whitespace split that bare tokenization would otherwise break.
function parseRefTokens(arg: string): RefTok[] {
  const out: RefTok[] = [];
  const re = /@\[([^\]]*)\]|@(\S+)|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arg)) !== null) {
    if (m[1] !== undefined) out.push({ kind: "ref", name: canonLemma(m[1]) });
    else if (m[2] !== undefined) out.push({ kind: "ref", name: canonLemma(m[2]) });
    else if (m[3] !== undefined) out.push({ kind: "lit", text: m[3] });
  }
  return out;
}
// First @ref in `arg` not in the store, formatted for display (or null).
function firstUnknownRef(arg: string): string | null {
  for (const t of parseRefTokens(arg))
    if (t.kind === "ref" && !lemmaStore.has(t.name)) return lemmaRefStr(t.name);
  return null;
}
// Parse a lone lemma name from an argument: accepts `name`, `[name with spaces]`,
// `@name`, or `@[name with spaces]`. Returns the canonical key.
function parseLemmaNameArg(s: string): string {
  let t = s.trim();
  if (t.startsWith("@")) t = t.slice(1).trim();
  const br = t.match(/^\[([^\]]*)\]$/);
  if (br) t = br[1];
  return canonLemma(t);
}
// Split a `<name> <rest>` argument into [canonicalName, rest], honoring a
// leading [bracketed name] so multi-word names don't eat the rest.
function splitLemmaNameArg(arg: string): [string, string] {
  const t = arg.trim();
  const br = t.match(/^\[([^\]]*)\]\s*([\s\S]*)$/);
  if (br) return [canonLemma(br[1]), br[2].trim()];
  const sp = t.search(/\s/);
  if (sp === -1) return [canonLemma(t), ""];
  return [canonLemma(t.slice(0, sp)), t.slice(sp + 1).trim()];
}

function expandLemmaRefs(arg: string): {
  expanded: string;
  components: Array<{ label: string | null; twists: string }>;
} | null {
  const components: Array<{ label: string | null; twists: string }> = [];
  const parts: string[] = [];
  for (const t of parseRefTokens(arg)) {
    if (t.kind === "ref") {
      const entry = lemmaStore.get(t.name);
      if (!entry) return null;
      const tw = tokenTwists(entry.twists);
      const resolved = entry.twists.startsWith("cap:") && tw
        ? twistsToSymbolic(tw)
        : entry.twists;
      parts.push(resolved);
      components.push({ label: t.name, twists: resolved });
    } else {
      parts.push(t.text);
      components.push({ label: null, twists: t.text });
    }
  }
  return { expanded: parts.join(""), components };
}

// ---------------------------------------------------------------------------
// Rendezvous helpers — locking, timeouts, commit application
// ---------------------------------------------------------------------------

function pickFreeNote(currency: string, N: number): NoteEntry | null {
  let exact: NoteEntry | null = null;
  let larger: NoteEntry | null = null;
  for (const n of noteStore.values()) {
    if (n.currency !== currency) continue;
    if (n.denomination === N) { exact = n; break; }
    if (n.denomination > N && (!larger || n.denomination < larger.denomination)) larger = n;
  }
  return exact ?? larger;
}

function detachFromFree(chosen: NoteEntry, N: number): { outgoing: string; change: NoteEntry | null } | null {
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
}

function lockToken(token: string, entry: NoteEntry, proposalId: string): void {
  lockedNotes.set(token, {
    token,
    currency: entry.currency,
    denomination: entry.denomination,
    receivedFrom: entry.receivedFrom,
    proposalId,
    lockedAt: Date.now(),
  });
}

function releaseLockedFor(proposalId: string): void {
  for (const [token, lock] of lockedNotes) {
    if (lock.proposalId !== proposalId) continue;
    noteStore.set(token, {
      token: lock.token,
      currency: lock.currency,
      denomination: lock.denomination,
      receivedFrom: lock.receivedFrom,
    });
    lockedNotes.delete(token);
  }
}

function scheduleProposalTimeout(id: string, ms: number): void {
  const existing = proposalTimers.get(id);
  if (existing !== undefined) clearTimeout(existing);
  const t = setTimeout(() => proposalTimedOut(id), ms) as unknown as number;
  proposalTimers.set(id, t);
}

function clearProposalTimeout(id: string): void {
  const t = proposalTimers.get(id);
  if (t !== undefined) clearTimeout(t);
  proposalTimers.delete(id);
}

function proposalTimedOut(id: string): void {
  const state = proposals.get(id);
  if (!state) return;
  releaseLockedFor(id);
  proposals.delete(id);
  proposalTimers.delete(id);
  saveNotes();
  renderNotes();
  if (state.role === "proposer" && qpeer) {
    const self = qpeer.peerId;
    const targets = uniqueParticipants(state.proposal).filter(p => p !== self);
    for (const t of targets) qpeer.send(t, { kind: "rdv-abort", id, reason: "timeout" });
  }
  addMessage("", `· rendezvous ${shortRdvId(id)} expired`, "system");
}

/// Apply a commit on this peer: for each row that names me, remove the locked
/// gives token and register the assigned gets token. Returns false if any
/// expectation is violated (in which case caller should not finalize state).
function applyCommit(state: ProposalState, commitRows: CommitRow[]): boolean {
  const myId = qpeer?.peerId ?? "";
  const myRows = state.proposal.rows.filter(r => r.participant === myId);
  const matched: CommitRow[] = [];
  const remaining = commitRows.filter(c => c.participant === myId);
  for (const myRow of myRows) {
    const idx = remaining.findIndex(c =>
      parseNoteLabel(c.getsToken)?.currency === myRow.gets.currency &&
      noteDenomination(c.getsToken) === myRow.gets.denomination &&
      parseNoteLabel(c.getsToken)?.kind === "note" &&
      validateCapability(c.getsToken));
    if (idx < 0) return false;
    matched.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  for (const cr of matched) {
    lockedNotes.delete(cr.givesToken);
    const parsed = parseNoteLabel(cr.getsToken);
    if (!parsed) continue;
    noteStore.set(cr.getsToken, {
      token: cr.getsToken,
      currency: parsed.currency,
      denomination: noteDenomination(cr.getsToken),
      receivedFrom: state.proposal.proposerName,
    });
  }
  return true;
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
      sys("  /cap [label]     — generate a new ZFA capability");
      sys("  /grant [label]   — generate and share a ZFA capability token");
      sys("  /zfa [token]     — validate a capability token");
      sys("  /braket <state>  — evaluate bra-ket (states: 0 1 + - i -i)");
      sys("  /qucalc [twists] — evaluate RhoQuCalc twist sequence");
      sys("  /conj <twists>   — Hermitian adjoint (reverse + parity-flip); flags self-adjoint");
      sys("  /freq [n|twists] — ZFA frequency spectrum; C(2n,n) arrangements at level n");
      sys("  /dump            — summary of all logic shared this session");
      sys("  /lemma           — list named lemmas");
      sys("  /lemma <n> [tw]  — register @n; omit twists to auto-allocate from name");
      sys("  /request <n>     — request @n from whoever holds it");
      sys("  /pass <n> <peer> — transfer @n directly to a named peer");
      sys("  /note [sub]      — promissory notes (declare|grant|pass|redeem|split|merge|balance)");
      sys("  /rdv [sub]       — n-party atomic rendezvous (swap|accept|reject|abort|list)");
      sys("  /poll [sub]      — group vote: new <q> [| seeds] [ranked] · add <opt> · vote · status · lock · close · list");
      sys("  /dyncap [sub]    — hash-only dynamic capabilities (status|peers)");
      sys("  /probe [sub]     — discrepancy probe window state (status|clear)");
      sys("  /room [sub]      — multi-room tabs (list|join <cap>|leave|ref)");
      sys("  /share <sel> to <room>  — bridge a lemma/chat/note into another tab");
      sys("  /channel [sub]   — tagged messages (listen|unlisten|send <name> <text>|list)");
      sys("  /script <c1>;…   — sequential command chain (// to skip a segment)");
      sys("  /persist [sub]   — agreed-replication of public state (@lemma|currency …)");
      sys("  /rhoqu <src>     — RhoQu macro: process/new/parallel/call → /commands");
      sys("  @name in args    — expand named lemma (e.g. /qucalc @major @minor)");
      sys("  [multi word]      — multi-word names: /lemma [all men are mortal] ^v<>  →  @[all men are mortal]");
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

    case "poll": {
      const sub = (parts[1] ?? "").toLowerCase();
      if (!sub || sub === "list") {
        if (pollStore.size === 0) {
          sys("no polls yet");
          sys("  /poll new <question> [| seed1, seed2] [ranked]   — then /poll add <option> to collect ideas");
        } else {
          sys(`polls (${pollStore.size}):`);
          for (const p of [...pollStore.values()].sort((a, b) => b.createdAt - a.createdAt)) {
            sys(`  ${p.status === "open" ? "●" : "✓"} ${p.id}  "${p.question}"  [${p.method}]  ${p.options.length} options · ${Object.keys(p.ballots).length} ballots`);
          }
        }
        break;
      }
      if (sub === "new") {
        let rest = parts.slice(2).join(" ");
        let method: PollMethod = "approval";
        if (/\s(ranked|irv)\s*$/i.test(" " + rest)) { method = "ranked"; rest = rest.replace(/\s*(ranked|irv)\s*$/i, "").trim(); }
        else if (/\sapproval\s*$/i.test(" " + rest)) { rest = rest.replace(/\s*approval\s*$/i, "").trim(); }
        const bar = rest.indexOf("|");
        const question = (bar < 0 ? rest : rest.slice(0, bar)).trim();
        const options = bar < 0 ? [] : rest.slice(bar + 1).split(",").map((s) => s.trim()).filter(Boolean);
        if (!question) { sys("a poll needs a question: /poll new <question> [| seed options] [ranked]"); break; }
        createPoll(question, options, method);
        sys(`poll created: "${question}" [${method}]${options.length ? ` — ${options.length} seed options` : " — open for nominations (use /poll add … or the card's add box)"}`);
        break;
      }
      if (sub === "add") {
        const a = parts.slice(2);
        let id: string | undefined; let text: string;
        if (a[0] && pollStore.has(a[0])) { id = a[0]; text = a.slice(1).join(" "); }
        else { text = a.join(" "); }
        const poll = findPoll(id);
        if (!poll) { sys("no open poll — start one with /poll new …"); break; }
        if (!text.trim()) { sys("usage: /poll add <option text>"); break; }
        addOption(poll, text);
        sys(`added option "${text.trim()}" to "${poll.question}"`);
        break;
      }
      if (sub === "vote") {
        const a = parts.slice(2);
        let id: string | undefined; let choiceStr: string;
        if (a[0] && pollStore.has(a[0])) { id = a[0]; choiceStr = a.slice(1).join(" "); }
        else { choiceStr = a.join(" "); }
        const poll = findPoll(id);
        if (!poll) { sys("no open poll to vote in — start one with /poll new …"); break; }
        if (poll.status !== "open") { sys("that poll is already closed"); break; }
        if (poll.options.length === 0) { sys("no options yet — add some with /poll add <option>"); break; }
        const choices = resolveChoices(poll, choiceStr);
        if (choices.length === 0) {
          sys(`could not match your choice. options: ${sortedOptions(poll).map((o, i) => `${i + 1}. ${o.text}`).join("   ")}`);
          break;
        }
        castVote(poll, choices);
        const names = choices.map((cid) => poll.options.find((o) => o.id === cid)?.text ?? cid);
        sys(`voted in "${poll.question}": ${names.join(poll.method === "ranked" ? " > " : ", ")}`);
        break;
      }
      if (sub === "status" || sub === "close" || sub === "lock") {
        const id = parts[2] && pollStore.has(parts[2]) ? parts[2] : undefined;
        const poll = findPoll(id);
        if (!poll) { sys("no poll found"); break; }
        if (sub === "lock") { lockNominations(poll); sys(`nominations locked for "${poll.question}"`); break; }
        if (sub === "close") {
          closePoll(poll);
          if (poll.status === "closed" && poll.result) sys(`closed "${poll.question}" — ${summarizeWinners(poll, poll.result)}`);
          break;
        }
        const counts = liveCounts(poll);
        sys(`"${poll.question}" [${poll.method}] — ${poll.status}${poll.nominationsLocked ? " · locked" : ""} (${poll.options.length} options · ${Object.keys(poll.ballots).length} ballots)`);
        for (const o of sortedOptions(poll)) sys(`  ${o.text}: ${counts[o.id] ?? 0}`);
        if (poll.status === "closed" && poll.result) sys("  " + summarizeWinners(poll, poll.result));
        break;
      }
      sys("usage: /poll new <q> [| seeds] [ranked] · add <opt> · vote [id] <choices> · status · lock · close · list");
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
            sys(`  ${lemmaRefStr(name)}  =  ${entry.twists}${entry.cap ? `  [cap: ${entry.cap}]` : ""}  (by ${entry.who})`);
          }
        }
        break;
      }
      // Name may be bracketed for multi-word: /lemma [all men are mortal] <tw>.
      const [lemmaName, lemmaTwistsArg] = splitLemmaNameArg(arg);
      if (!lemmaName) {
        sys("usage: /lemma <name> [twists|@ref1 @ref2|cap:token]");
        sys("  multi-word name: /lemma [all men are mortal] ^v<>  (reference as @[all men are mortal])");
        sys("  omit twists to auto-allocate from the name");
        break;
      }
      if (/[\[\]:]/.test(lemmaName)) {
        sys(`invalid lemma name: '${lemmaName}'  (no brackets or colons; spaces OK via [name])`);
        break;
      }
      const isAutoAlloc = !lemmaTwistsArg;
      let resolvedTwistsStr: string;
      if (isAutoAlloc) {
        resolvedTwistsStr = twistsToSymbolic(allocateTwists(lemmaName));
      } else if (lemmaTwistsArg.includes("@")) {
        const result = expandLemmaRefs(lemmaTwistsArg);
        if (!result) {
          sys(`unknown lemma reference: ${firstUnknownRef(lemmaTwistsArg) ?? "@?"}`);
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
      // Lemmas are content-addressed by name. Once @name is declared, it
      // binds to that value for the room's lifetime. Re-declaration with
      // different content would silently corrupt the shared vocabulary.
      const existing = lemmaStore.get(lemmaName);
      if (existing && existing.twists !== resolvedTwistsStr) {
        sys(`${lemmaRefStr(lemmaName)} already declared with different twists (${existing.twists})`);
        sys("  · refusing re-declaration; choose a new name");
        break;
      }
      if (existing && existing.twists === resolvedTwistsStr) {
        sys(`${lemmaRefStr(lemmaName)} already declared (no change)`);
        break;
      }
      const { pos: lPos, neg: lNeg, balanced: lBal } = twistStats(checkTw);
      const lemWho = myName || (qpeer ? shortId(qpeer.peerId) : "local");
      const lemCap = lBal ? lemmaToCapToken(lemmaName, checkTw) : undefined;
      lemmaStore.set(lemmaName, { twists: resolvedTwistsStr, who: lemWho, cap: lemCap });
      sys(`lemma registered: ${lemmaRefStr(lemmaName)}  =  ${resolvedTwistsStr}${isAutoAlloc ? "  (auto-allocated)" : ""}`);
      sys(`  twists: ${checkTw.length}  (${lPos}+/${lNeg}-)  ZFA: ${lBal ? "✓" : "✗"}`);
      if (lemCap) sys(`  cap: ${lemCap}  (share with /zfa to verify)`);
      signedBroadcast({ kind: "lemma", name: lemmaName, twists: resolvedTwistsStr, cap: lemCap, who: lemWho });
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
          const badName = firstUnknownRef(arg.trim());
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
          const lbl = c.label ? lemmaRefStr(c.label) : `(${c.twists})`;
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

    case "conj": {
      let ctwists: Uint8Array | null = null;
      let csrc = "";
      if (!arg) {
        sys("usage: /conj <twists>");
        sys("  twists: symbolic (^v<>/\\+-) or hex digits 0-7 or cap:label:hex or @name");
        sys("  Hermitian adjoint: reverse + parity-flip (XOR 1).  Identity: E + E† ≡ ZFA.");
        break;
      } else if (arg.trim().includes("@")) {
        const result = expandLemmaRefs(arg.trim());
        if (!result) {
          const badName = firstUnknownRef(arg.trim());
          sys(`unknown lemma: ${badName ?? "@?"}  (type /lemma to list)`);
          break;
        }
        ctwists = parseSymbolicTwists(result.expanded);
        csrc = `composed: ${arg.trim()}`;
      } else if (arg.trim().startsWith("cap:")) {
        ctwists = tokenTwists(arg.trim());
        csrc = `token: ${arg.trim()}`;
      } else {
        ctwists = parseSymbolicTwists(arg.trim());
        csrc = `input: ${arg.trim()}`;
      }
      if (!ctwists || ctwists.length === 0) {
        sys("/conj: could not parse twists");
        break;
      }
      const adj = adjointHistory(ctwists);
      const selfAdj = isSelfAdjoint(ctwists);
      const hSym = twistsToSymbolic(ctwists);
      const aSym = twistsToSymbolic(adj);
      const combined = new Uint8Array(ctwists.length + adj.length);
      combined.set(ctwists, 0);
      combined.set(adj, ctwists.length);
      const combinedStats = twistStats(combined);
      sys("Hermitian adjoint (H†):");
      sys(`  ${csrc}`);
      sys(`  H  = ${hSym}   (n=${ctwists.length})`);
      sys(`  H† = ${aSym}   (reversed + parity-flipped)`);
      sys(`  self-adjoint (H = H†): ${selfAdj ? "✓" : "✗"}`);
      sys(`  H || H† balanced: ${combinedStats.balanced ? "✓" : "✗"}  (E + E† ≡ ZFA)`);
      if (selfAdj) {
        sys(`  member of Σ_sa  → fixed locus of QLF adjoint involution`);
        sys(`  (counterpart of Re(s)=1/2 in Riemann ξ;  see ReverseMathematics §4.9)`);
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
      const lemmaName = parseLemmaNameArg(arg);
      if (!lemmaName) { sys("usage: /request <lemma-name>  (multi-word: /request [name with spaces])"); break; }
      if (!qpeer) { sys("not connected"); break; }
      if (lemmaStore.has(lemmaName)) { sys(`you already hold ${lemmaRefStr(lemmaName)}`); break; }
      const myLabel = myName || shortId(qpeer.peerId);
      qpeer.broadcast({ kind: "lemma-request", name: lemmaName, fromName: myLabel });
      sys(`· requested ${lemmaRefStr(lemmaName)} — waiting for holder to /pass it`);
      break;
    }

    case "pass": {
      // Name may be bracketed for multi-word: /pass [all men are mortal] Alice.
      const [passLemma, targetName] = splitLemmaNameArg(arg);
      if (!passLemma || !targetName) { sys("usage: /pass <lemma-name> <peer-name>  (multi-word: /pass [name] peer)"); break; }
      if (!qpeer) { sys("not connected"); break; }
      const passEntry = lemmaStore.get(passLemma);
      if (!passEntry) { sys(`you don't hold ${lemmaRefStr(passLemma)} — nothing to pass`); break; }
      const targetId = findPeerByName(targetName);
      if (!targetId) { sys(`unknown peer: '${targetName}'  (check Peers list for exact name)`); break; }
      const sent = qpeer.send(targetId, { kind: "lemma-pass", name: passLemma, twists: passEntry.twists, cap: passEntry.cap });
      if (!sent) { sys(`cannot reach ${targetName} — data channel not open`); break; }
      lemmaStore.delete(passLemma);
      saveLemmas();
      renderLemmas();
      sys(`· ${lemmaRefStr(passLemma)} transferred to ${targetName} — removed from your lemmas`);
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
          signedBroadcast({ kind: "note-declare", currency, token, who });
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

    case "rdv": {
      const rParts = arg.trim().split(/\s+/);
      const sub = (rParts[0] || "").toLowerCase();
      const a = rParts.slice(1);

      const findByPrefix = (prefix: string): ProposalState | null => {
        for (const [id, s] of proposals) if (id.startsWith(prefix)) return s;
        return null;
      };

      switch (sub) {
        case "":
        case "list": {
          if (proposals.size === 0 && lockedNotes.size === 0) {
            sys("no pending rendezvous proposals");
            sys("  /rdv swap <giveCur> <giveN> <getCur> <getN> <peer>  propose a 2-party swap");
            sys("  /rdv accept <id>   — accept a pending proposal");
            sys("  /rdv reject <id>   — decline");
            sys("  /rdv abort  <id>   — cancel a proposal you proposed");
            break;
          }
          if (proposals.size > 0) {
            sys(`proposals (${proposals.size}):`);
            const myId = qpeer?.peerId ?? "";
            for (const [id, s] of proposals) {
              const role = s.role === "proposer" ? "(yours)" : `from ${s.proposal.proposerName}`;
              const myRow = s.proposal.rows.find(r => r.participant === myId);
              const summary = myRow
                ? `you give ${myRow.gives.currency} ${myRow.gives.denomination}, get ${myRow.gets.currency} ${myRow.gets.denomination}`
                : "no row for you";
              sys(`  ${shortRdvId(id)}  ${role}  — ${summary}  [${s.myStatus}]`);
            }
          }
          if (lockedNotes.size > 0) {
            sys(`locked notes (${lockedNotes.size}):`);
            for (const lock of lockedNotes.values()) {
              sys(`  ${lock.currency} ${lock.denomination}  (for rdv ${shortRdvId(lock.proposalId)})`);
            }
          }
          break;
        }

        case "swap": {
          const giveCur    = a[0];
          const giveN      = parseInt(a[1] ?? "", 10);
          const getCur     = a[2];
          const getN       = parseInt(a[3] ?? "", 10);
          const targetName = a.slice(4).join(" ").trim();
          if (!giveCur || !getCur || isNaN(giveN) || isNaN(getN) || giveN < 1 || getN < 1 || !targetName) {
            sys("usage: /rdv swap <giveCur> <giveN> <getCur> <getN> <peer>");
            sys("  example: /rdv swap USD 30 EUR 20 Bob");
            break;
          }
          if (!qpeer) { sys("not connected"); break; }
          const targetId = findPeerByName(targetName);
          if (!targetId) { sys(`unknown peer: '${targetName}'`); break; }

          const chosen = pickFreeNote(giveCur, giveN);
          if (!chosen) { sys(`no ${giveCur} note of denomination ≥ ${giveN}`); break; }
          const detached = detachFromFree(chosen, giveN);
          if (!detached) { sys("split failed"); break; }

          const id = newProposalId();
          const myId = qpeer.peerId;
          const myLabel = myName || shortId(myId);
          const rows: Row[] = cyclicSwap(
            myId,    { currency: giveCur, denomination: giveN },
            targetId,{ currency: getCur,  denomination: getN  },
          );
          const proposal: Proposal = {
            id, proposer: myId, proposerName: myLabel, rows,
            expiresAt: Date.now() + RDV_TIMEOUT_MS,
          };
          const lockEntry: NoteEntry = {
            token: detached.outgoing, currency: giveCur, denomination: giveN,
            receivedFrom: chosen.receivedFrom,
          };
          lockToken(detached.outgoing, lockEntry, id);
          proposals.set(id, {
            proposal, role: "proposer", myStatus: "accepted",
            acceptedBy: new Map([[myId, detached.outgoing]]),
          });
          scheduleProposalTimeout(id, RDV_TIMEOUT_MS);
          saveNotes();
          renderNotes();

          const sent = qpeer.send(targetId, { kind: "rdv-propose", proposal });
          if (!sent) {
            releaseLockedFor(id);
            proposals.delete(id);
            clearProposalTimeout(id);
            saveNotes();
            renderNotes();
            sys(`cannot reach ${targetName} — data channel not open`);
            break;
          }
          sys(`· proposed rendezvous ${shortRdvId(id)} to ${targetName}`);
          sys(`  you give ${giveCur} ${giveN}, get ${getCur} ${getN}`);
          sys(`  expires in ${Math.round(RDV_TIMEOUT_MS / 1000)}s — /rdv abort ${shortRdvId(id)} to cancel`);
          if (detached.change) sys(`  (change ${detached.change.denomination} returned to your wallet)`);
          break;
        }

        case "accept": {
          const prefix = a[0];
          if (!prefix) { sys("usage: /rdv accept <id>"); break; }
          if (!qpeer) { sys("not connected"); break; }
          const state = findByPrefix(prefix);
          if (!state) { sys(`no proposal matching '${prefix}'`); break; }
          const myId = qpeer.peerId;
          const isProposer = state.role === "proposer";
          // Proposer-after-counter case: state.role is still "proposer" but
          // acceptedBy was cleared by the inbound counter handler, so the
          // proposer must re-accept the new terms. For a participant, the
          // myStatus flag tracks acceptance.
          const alreadyAccepted = isProposer
            ? state.acceptedBy.has(myId)
            : state.myStatus === "accepted";
          if (alreadyAccepted) { sys(`already accepted`); break; }
          const myRows = state.proposal.rows.filter(r => r.participant === myId);
          if (myRows.length === 0) { sys("you have no row in this rendezvous"); break; }
          if (myRows.length > 1) { sys("multi-row participation not yet supported"); break; }
          const row = myRows[0];

          const chosen = pickFreeNote(row.gives.currency, row.gives.denomination);
          if (!chosen) {
            sys(`cannot accept: no free ${row.gives.currency} note of denomination ≥ ${row.gives.denomination}`);
            break;
          }
          const detached = detachFromFree(chosen, row.gives.denomination);
          if (!detached) { sys("split failed"); break; }
          const lockEntry: NoteEntry = {
            token: detached.outgoing, currency: row.gives.currency, denomination: row.gives.denomination,
            receivedFrom: chosen.receivedFrom,
          };
          lockToken(detached.outgoing, lockEntry, state.proposal.id);

          if (isProposer) {
            // Local accept: record in acceptedBy and run the same
            // "all-accepted → commit" path the inbound rdv-accept handler
            // does. No envelope sent (we *are* the proposer).
            state.acceptedBy.set(myId, detached.outgoing);
            saveNotes();
            renderNotes();
            sys(`· re-accepted rendezvous ${shortRdvId(state.proposal.id)} on the new terms`);
            sys(`  locked ${row.gives.currency} ${row.gives.denomination}`);
            if (detached.change) sys(`  (change ${detached.change.denomination} returned to your wallet)`);
            const participants = uniqueParticipants(state.proposal);
            if (!participants.every(p => state.acceptedBy.has(p))) break;
            // All-accepted — build and dispatch the commit.
            const N = state.proposal.rows.length;
            const commitRows: CommitRow[] = state.proposal.rows.map((r, i) => {
              const nextRow = state.proposal.rows[(i + 1) % N];
              return {
                participant: r.participant,
                givesToken: state.acceptedBy.get(r.participant)!,
                getsToken:  state.acceptedBy.get(nextRow.participant)!,
              };
            });
            for (const p of participants) {
              if (p === myId) continue;
              qpeer.send(p, { kind: "rdv-commit", id: state.proposal.id, rows: commitRows });
            }
            const ok = applyCommit(state, commitRows);
            proposals.delete(state.proposal.id);
            clearProposalTimeout(state.proposal.id);
            saveNotes();
            renderNotes();
            sys(ok ? `  · committed rdv ${shortRdvId(state.proposal.id)}` : `  · commit application failed locally`);
            break;
          }

          // Participant path — original behavior.
          state.myStatus = "accepted";
          saveNotes();
          renderNotes();

          const sent = qpeer.send(state.proposal.proposer, {
            kind: "rdv-accept", id: state.proposal.id, token: detached.outgoing,
          });
          if (!sent) {
            releaseLockedFor(state.proposal.id);
            state.myStatus = "pending";
            saveNotes();
            renderNotes();
            sys("cannot reach proposer — try again");
            break;
          }
          sys(`· accepted rendezvous ${shortRdvId(state.proposal.id)}`);
          sys(`  locked ${row.gives.currency} ${row.gives.denomination}; awaiting commit…`);
          if (detached.change) sys(`  (change ${detached.change.denomination} returned to your wallet)`);
          break;
        }

        case "reject": {
          const prefix = a[0];
          if (!prefix) { sys("usage: /rdv reject <id>"); break; }
          const state = findByPrefix(prefix);
          if (!state) { sys(`no proposal matching '${prefix}'`); break; }
          if (state.role !== "participant") { sys("you proposed this; use /rdv abort instead"); break; }
          if (state.myStatus !== "pending") { sys(`already ${state.myStatus}`); break; }
          if (qpeer) qpeer.send(state.proposal.proposer, { kind: "rdv-reject", id: state.proposal.id });
          proposals.delete(state.proposal.id);
          clearProposalTimeout(state.proposal.id);
          saveNotes();
          renderNotes();
          sys(`· rejected rendezvous ${shortRdvId(state.proposal.id)}`);
          break;
        }

        case "abort": {
          const prefix = a[0];
          if (!prefix) { sys("usage: /rdv abort <id>"); break; }
          const state = findByPrefix(prefix);
          if (!state) { sys(`no proposal matching '${prefix}'`); break; }
          if (state.role !== "proposer") { sys("you didn't propose this; use /rdv reject instead"); break; }
          releaseLockedFor(state.proposal.id);
          if (qpeer) {
            const self = qpeer.peerId;
            const targets = uniqueParticipants(state.proposal).filter(p => p !== self);
            for (const t of targets) qpeer.send(t, { kind: "rdv-abort", id: state.proposal.id, reason: "proposer-cancel" });
          }
          proposals.delete(state.proposal.id);
          clearProposalTimeout(state.proposal.id);
          saveNotes();
          renderNotes();
          sys(`· aborted rendezvous ${shortRdvId(state.proposal.id)}`);
          break;
        }

        case "counter": {
          // /rdv counter <id> <giveCur> <giveN> <getCur> <getN>
          //
          // Propose new terms in an existing 2-party rendezvous. The current
          // round's locks (mine and theirs, if accepted) are released; the
          // proposal's rows are replaced with the new cyclic swap; my new
          // gives token is locked; an rdv-counter envelope is sent to the
          // other participant; my status is "accepted" (I just chose these
          // terms); their status is reset to "pending". Either party can
          // counter at any pending state; this round-robins until accept,
          // reject, abort, or timeout.
          if (!qpeer) { sys("not connected"); break; }
          const prefix = a[0];
          const giveCur = a[1];
          const giveN   = parseInt(a[2] ?? "", 10);
          const getCur  = a[3];
          const getN    = parseInt(a[4] ?? "", 10);
          if (!prefix || !giveCur || !getCur || isNaN(giveN) || isNaN(getN) || giveN < 1 || getN < 1) {
            sys("usage: /rdv counter <id> <giveCur> <giveN> <getCur> <getN>");
            sys("  example: /rdv counter a3f1c2 USD 25 EUR 20");
            break;
          }
          const state = findByPrefix(prefix);
          if (!state) { sys(`no proposal matching '${prefix}'`); break; }
          const myId = qpeer.peerId;
          const otherId = uniqueParticipants(state.proposal).find(p => p !== myId);
          if (!otherId) { sys("no other participant to counter to"); break; }

          // Release current locks (both my own and the other's, if any).
          releaseLockedFor(state.proposal.id);
          state.acceptedBy.clear();

          // Replace the proposal's rows with the new cyclic swap.
          const myName2 = myName || shortId(myId);
          const newRows: Row[] = cyclicSwap(
            myId,    { currency: giveCur, denomination: giveN },
            otherId, { currency: getCur,  denomination: getN  },
          );
          state.proposal.rows = newRows;
          state.proposal.proposerName = myName2;   // attribute the latest terms to the counterer
          state.proposal.expiresAt = Date.now() + RDV_TIMEOUT_MS;
          clearProposalTimeout(state.proposal.id);
          scheduleProposalTimeout(state.proposal.id, RDV_TIMEOUT_MS);

          // Lock my new gives token.
          const chosen = pickFreeNote(giveCur, giveN);
          if (!chosen) {
            sys(`cannot counter: no free ${giveCur} note of denomination ≥ ${giveN}`);
            break;
          }
          const detached = detachFromFree(chosen, giveN);
          if (!detached) { sys("split failed"); break; }
          const lockEntry: NoteEntry = {
            token: detached.outgoing, currency: giveCur, denomination: giveN,
            receivedFrom: chosen.receivedFrom,
          };
          lockToken(detached.outgoing, lockEntry, state.proposal.id);
          state.acceptedBy.set(myId, detached.outgoing);
          state.myStatus = "accepted";   // I implicitly accept my own counter
          saveNotes();
          renderNotes();

          // Send the counter envelope, including the token I just locked so
          // the recipient can record it in their acceptedBy for the eventual
          // commit construction.
          const sent = qpeer.send(otherId, {
            kind: "rdv-counter", id: state.proposal.id, rows: newRows,
            proposerName: myName2, token: detached.outgoing,
          });
          if (!sent) {
            releaseLockedFor(state.proposal.id);
            state.acceptedBy.delete(myId);
            sys("cannot reach the other participant — counter not delivered");
            break;
          }
          sys(`· counter sent for rendezvous ${shortRdvId(state.proposal.id)}`);
          sys(`  new terms: you give ${giveCur} ${giveN}, get ${getCur} ${getN}`);
          if (detached.change) sys(`  (change ${detached.change.denomination} returned to your wallet)`);
          break;
        }

        default:
          sys(`unknown subcommand: /rdv ${sub}`);
          sys("  /rdv [list]                                        — show pending proposals");
          sys("  /rdv swap <giveCur> <giveN> <getCur> <getN> <peer> — propose a 2-party swap");
          sys("  /rdv counter <id> <giveCur> <giveN> <getCur> <getN> — propose new terms in an existing rendezvous");
          sys("  /rdv accept <id>                                   — accept current terms");
          sys("  /rdv reject <id>                                   — decline");
          sys("  /rdv abort  <id>                                   — cancel your proposal");
      }
      break;
    }

    case "probe": {
      const sub = (arg.trim().split(/\s+/)[0] || "status").toLowerCase();
      if (sub === "status") {
        sys(`probe window: ${probe.open ? "open" : "closed"}`);
        if (probe.open) {
          sys(`  contributors so far: ${probe.contributors.size}/${SAMPLE_SIZE}`);
          sys(`  observations: ${probe.observations.length}`);
        }
        sys(`ignored-for-sync peers (${ignoredForSync.size}):`);
        for (const p of ignoredForSync) sys(`  ${peerLabel(p)}  (${p.slice(0, 16)}…)`);
      } else if (sub === "clear") {
        const n = ignoredForSync.size;
        ignoredForSync.clear();
        saveNotes();
        sys(`cleared ${n} ignored-for-sync entries`);
      } else {
        sys(`unknown subcommand: /probe ${sub}`);
        sys("  /probe [status]  — show probe window state and ignored peers");
        sys("  /probe clear     — clear the ignored-for-sync list");
      }
      break;
    }

    case "dyncap": {
      const sub = (arg.trim().split(/\s+/)[0] || "status").toLowerCase();
      if (sub === "whoami" || sub === "status") {
        if (!dyncapState) { sys("dyncap not initialized"); break; }
        const currentRoom = activeRoom.roomId;
        const seqHere = dyncapState.seqByRoom[currentRoom] ?? 0;
        sys(`dyncap anchor: cap:peer/dyn:${dyncapState.anchor}`);
        sys(`  seq in this room: ${seqHere}`);
        const roomCount = Object.keys(dyncapState.seqByRoom).length;
        if (roomCount > 1) sys(`  rooms with chain history: ${roomCount}`);
        sys(`  chain peers:      ${dyncapChains.size}`);
      } else if (sub === "peers") {
        if (dyncapChains.size === 0) { sys("no dyncap peers tracked yet"); break; }
        sys(`tracked peers (${dyncapChains.size}):`);
        for (const [peerId, entry] of dyncapChains) {
          const flag = entry.contested ? "  ⚠ CONTESTED" : "";
          sys(`  ${peerLabel(peerId)}  anchor: ${entry.anchor.slice(0, 16)}…  lastSeq: ${entry.lastSeq}${flag}`);
        }
      } else {
        sys(`unknown subcommand: /dyncap ${sub}`);
        sys("  /dyncap [status]  — show your anchor, current seq, tracked peer count");
        sys("  /dyncap peers     — list tracked peers with their pinned anchors");
      }
      break;
    }

    case "persist": {
      // /persist <selector> to <peer>   — ask peer to also store this item
      // /persist accept <id>            — accept a pending inbound request
      // /persist reject <id>            — discard a pending inbound request
      // /persist list                   — show pending inbound requests
      //
      // Cross-peer redundancy of public room knowledge. The receiver
      // explicitly opts in, so persistence is "by agreement" — the asker
      // requests, the receiver consents. On future startups, the existing
      // consensus probe + supermajority resolution reconciles any drift
      // across the now-redundant copies.
      const pParts = arg.trim().split(/\s+/);
      const sub = (pParts[0] || "list").toLowerCase();
      if (sub === "list" || sub === "") {
        if (pendingPersistRequests.size === 0) {
          sys("no pending persist requests");
          sys("  /persist @<lemma> to <peer>       — ask peer to store the lemma too");
          sys("  /persist currency <name> to <peer> — ask peer to store the currency declaration");
          sys("  /persist accept <id>              — accept an incoming request");
          break;
        }
        sys(`pending persist requests (${pendingPersistRequests.size}):`);
        for (const [id, req] of pendingPersistRequests) {
          const desc = req.kind === "lemma"
            ? `@${req.lemmaName} = ${req.lemmaEntry?.twists ?? "?"}`
            : `currency ${req.currencyEntry?.currency ?? "?"}  (token ${req.currencyToken?.slice(0, 24) ?? "?"}…)`;
          sys(`  ${id.slice(0, 8)}  from ${req.fromName}  →  ${desc}`);
        }
      } else if (sub === "accept") {
        const prefix = pParts[1] ?? "";
        if (!prefix) { sys("usage: /persist accept <id>"); break; }
        let found: PersistRequest | null = null;
        let foundId = "";
        for (const [id, req] of pendingPersistRequests) {
          if (id.startsWith(prefix)) { found = req; foundId = id; break; }
        }
        if (!found) { sys(`no pending request matching '${prefix}'`); break; }
        if (found.kind === "lemma" && found.lemmaName && found.lemmaEntry) {
          const name = found.lemmaName;
          const entry = found.lemmaEntry;
          const existing = lemmaStore.get(name);
          if (existing && existing.twists !== entry.twists) {
            sys(`· refused: you already hold @${name} with different twists (${existing.twists})`);
            sys(`  (the room's consensus probe will resolve this on next join)`);
            break;
          }
          if (!existing) {
            lemmaStore.set(name, entry);
            saveLemmas();
            renderLemmas();
          }
          sys(`· accepted: now persisting @${name} (${entry.twists})`);
        } else if (found.kind === "currency" && found.currencyToken && found.currencyEntry) {
          const tok = found.currencyToken;
          if (!knownCurrencies.has(tok)) {
            knownCurrencies.set(tok, found.currencyEntry);
            saveNotes();
            renderNotes();
          }
          sys(`· accepted: now persisting currency ${found.currencyEntry.currency} (issued by ${found.currencyEntry.issuer})`);
        }
        pendingPersistRequests.delete(foundId);
      } else if (sub === "reject") {
        const prefix = pParts[1] ?? "";
        if (!prefix) { sys("usage: /persist reject <id>"); break; }
        let foundId = "";
        for (const id of pendingPersistRequests.keys()) {
          if (id.startsWith(prefix)) { foundId = id; break; }
        }
        if (!foundId) { sys(`no pending request matching '${prefix}'`); break; }
        pendingPersistRequests.delete(foundId);
        sys(`· rejected persist request ${foundId.slice(0, 8)}`);
      } else if (sub.startsWith("@") || sub === "currency") {
        // Outbound request: /persist <selector> to <peer>
        if (!qpeer) { sys("not connected"); break; }
        const toIdx = pParts.lastIndexOf("to");
        if (toIdx < 1 || toIdx >= pParts.length - 1) {
          sys("usage: /persist <@lemma | currency <name>> to <peer>");
          break;
        }
        const targetName = pParts.slice(toIdx + 1).join(" ").trim();
        const targetId = findPeerByName(targetName);
        if (!targetId) { sys(`unknown peer: '${targetName}'`); break; }

        const reqId = Array.from(crypto.getRandomValues(new Uint8Array(8)))
          .map(b => b.toString(16).padStart(2, "0")).join("");
        const myLabel = myName || (qpeer ? shortId(qpeer.peerId) : "local");
        let payload: Record<string, unknown> | null = null;

        if (sub.startsWith("@")) {
          const name = parseLemmaNameArg(sub);
          const entry = lemmaStore.get(name);
          if (!entry) { sys(`you don't hold ${lemmaRefStr(name)}`); break; }
          payload = {
            kind: "persist-request", id: reqId, persistKind: "lemma",
            fromName: myLabel,
            lemmaName: name, lemmaEntry: entry,
          };
          sys(`· requesting ${targetName} to also persist @${name}`);
        } else {
          // sub === "currency"
          const cname = pParts[1] ?? "";
          if (!cname) { sys("usage: /persist currency <name> to <peer>"); break; }
          // Find the currency entry in knownCurrencies (any token I know with this name).
          let cEntry: KnownCurrency | null = null;
          let cTok = "";
          for (const [tok, e] of knownCurrencies) {
            if (e.currency === cname) { cEntry = e; cTok = tok; break; }
          }
          if (!cEntry) { sys(`unknown currency '${cname}' in this room`); break; }
          payload = {
            kind: "persist-request", id: reqId, persistKind: "currency",
            fromName: myLabel,
            currencyToken: cTok, currencyEntry: cEntry,
          };
          sys(`· requesting ${targetName} to also persist currency ${cname}`);
        }
        if (payload) qpeer.send(targetId, payload);
      } else {
        sys(`unknown subcommand: /persist ${sub}`);
        sys("  /persist @<lemma> to <peer>        — request peer to also persist");
        sys("  /persist currency <name> to <peer> — request peer to also persist");
        sys("  /persist accept <id>               — accept a pending inbound request");
        sys("  /persist reject <id>               — discard a pending inbound request");
        sys("  /persist list                      — show pending requests");
      }
      break;
    }

    case "channel": {
      // /channel listen <name>        — subscribe in this room
      // /channel unlisten <name>      — unsubscribe
      // /channel send <name> <text>   — broadcast a tagged message
      // /channel list                 — show subscriptions
      const cParts = arg.trim().split(/\s+/);
      const sub = (cParts[0] || "list").toLowerCase();
      const name = cParts[1] ?? "";
      if (sub === "list" || sub === "") {
        if (channelSubscriptions.size === 0) {
          sys("no channel subscriptions in this room");
          sys("  /channel listen <name>      — subscribe");
          sys("  /channel send <name> <text> — broadcast");
        } else {
          sys(`channel subscriptions (${channelSubscriptions.size}):`);
          for (const n of channelSubscriptions) sys(`  ${n}`);
        }
      } else if (sub === "listen") {
        if (!name) { sys("usage: /channel listen <name>"); break; }
        if (channelSubscriptions.has(name)) { sys(`already listening on '${name}'`); break; }
        channelSubscriptions.add(name);
        saveNotes();
        sys(`· listening on channel '${name}'`);
      } else if (sub === "unlisten") {
        if (!name) { sys("usage: /channel unlisten <name>"); break; }
        if (!channelSubscriptions.has(name)) { sys(`not listening on '${name}'`); break; }
        channelSubscriptions.delete(name);
        saveNotes();
        sys(`· unlistened from channel '${name}'`);
      } else if (sub === "send") {
        const text = cParts.slice(2).join(" ");
        if (!name || !text) { sys("usage: /channel send <name> <text>"); break; }
        if (!qpeer) { sys("not connected"); break; }
        // Tagged broadcast. Receivers without a matching subscription drop it.
        qpeer.broadcast({ kind: "channel-msg", channel: name, payload: text });
        sys(`· sent on channel '${name}': ${text}`);
      } else {
        sys(`unknown subcommand: /channel ${sub}`);
        sys("  /channel [list]              — show subscriptions");
        sys("  /channel listen <name>       — subscribe");
        sys("  /channel unlisten <name>     — unsubscribe");
        sys("  /channel send <name> <text>  — broadcast a tagged message");
      }
      break;
    }

    case "rhoqu": {
      const src = arg.trim();
      // Subcommands for managing registered on-handlers.
      if (src === "list") {
        if (rhoquHandlers.length === 0) {
          sys("no rhoqu on-handlers registered in this room");
        } else {
          sys(`rhoqu on-handlers (${rhoquHandlers.length}):`);
          for (const h of rhoquHandlers) sys(`  on ${h.channel}(${h.binding}) { … }`);
        }
        break;
      }
      if (src === "clear") {
        const n = rhoquHandlers.length;
        rhoquHandlers.length = 0;
        activeRoom.rhoquHandlers = rhoquHandlers;   // keep RoomContext field in sync
        sys(`cleared ${n} rhoqu on-handler${n === 1 ? "" : "s"}`);
        break;
      }
      if (!src) {
        sys("usage: /rhoqu <source>");
        sys("  /rhoqu list                          — show registered on-handlers");
        sys("  /rhoqu clear                         — drop all on-handlers in this room");
        sys("  process P(a, b) { /grant $a; /lemma $b; } P(fork-a, alice);");
        sys("  if has(@met-bob) { /qucalc @met-bob; } else { /lemma met-bob ^v; }");
        sys("  on forks(msg) { /qucalc @msg; }      — register a channel-msg handler");
        break;
      }
      const rhoCtx: RhoQuContext = {
        hasLemma:  (name) => lemmaStore.has(canonLemma(name)),
        balance:   (currency) => {
          let total = 0;
          for (const n of noteStore.values()) if (n.currency === currency) total += n.denomination;
          return total;
        },
        isCurrencyDeclared: (name) => {
          for (const e of knownCurrencies.values()) if (e.currency === name) return true;
          return false;
        },
        peerCount:    () => peers.size,
        isConnected:  () => qpeer !== null,
        myCurrentSeq: () => dyncapState?.seqByRoom[activeRoom.roomId] ?? 0,
        registerOnHandler: (h) => { rhoquHandlers.push(h); },
      };
      let cmds: string[];
      try {
        cmds = rhoquTranspile(src, rhoCtx);
      } catch (e) {
        if (e instanceof RhoQuError) sys(`· ${e.message}`);
        else sys(`· rhoqu parse error: ${String(e)}`);
        break;
      }
      const handlersAfter = rhoquHandlers.length;
      sys(`· rhoqu transpiled to ${cmds.length} command${cmds.length === 1 ? "" : "s"}`);
      let executed = 0;
      for (const c of cmds) {
        try { handleCommand(c); executed++; }
        catch (err) { sys(`· rhoqu error on '${c}': ${String(err)}`); }
      }
      sys(`· rhoqu: ${executed} executed${handlersAfter > 0 ? `, ${handlersAfter} on-handler${handlersAfter === 1 ? "" : "s"} active` : ""}`);
      break;
    }

    case "script": {
      // /script cmd1; cmd2; cmd3
      //
      // Sequential command chain — each `;`-separated segment is run
      // through handleCommand exactly as if typed individually. Comments
      // (// prefix on a segment after trimming) are skipped. Errors in
      // one segment don't stop subsequent ones; each segment's output
      // appears in chat in order.
      const segments = arg.split(";").map(s => s.trim()).filter(s => s.length > 0);
      if (segments.length === 0) {
        sys("usage: /script <cmd1>; <cmd2>; <cmd3>");
        sys("  example: /script /grant fork-a; /lemma alice-thinking; /qucalc @alice-thinking");
        sys("  comments: //  (a segment beginning with // is skipped)");
        break;
      }
      let executed = 0;
      let skipped  = 0;
      for (const seg of segments) {
        if (seg.startsWith("//")) { skipped++; continue; }
        const cmdStr = seg.startsWith("/") ? seg : "/" + seg;
        try {
          handleCommand(cmdStr);
          executed++;
        } catch (e) {
          sys(`· script error on '${seg}': ${String(e)}`);
        }
      }
      sys(`· script: ${executed} executed${skipped > 0 ? `, ${skipped} skipped (comments)` : ""}`);
      break;
    }

    case "share": {
      // /share <selector> to <room-prefix>
      // Selectors:
      //   @<lemma-name>            re-declare the lemma in the target room
      //   msg <text>               post a chat-text message into the target room
      //   note <currency> <N>      re-mint a note (target room must hold cap:token-<currency>)
      //
      // The bridge is application-level: we briefly swap activeRoom to the
      // target context and call the existing dispatcher commands there. The
      // target room sees the action exactly as if the user typed it locally.
      const sParts = arg.trim().split(/\s+/);
      const toIdx = sParts.lastIndexOf("to");
      if (toIdx < 1 || toIdx >= sParts.length - 1) {
        sys("usage: /share <selector> to <room-prefix>");
        sys("  selectors: @<lemma>  |  msg <text>  |  note <currency> <N>");
        break;
      }
      const selector  = sParts.slice(0, toIdx).join(" ");
      const targetArg = sParts.slice(toIdx + 1).join(" ");

      // Resolve target room by prefix-match on roomId; reject ambiguous/empty.
      let target: RoomContext | null = null;
      const matches: RoomContext[] = [];
      for (const ctx of rooms.values()) {
        if (ctx.roomId === activeRoom.roomId) continue;
        if (ctx.roomId.startsWith(targetArg) || ctx.roomId === targetArg) matches.push(ctx);
      }
      if (matches.length === 0) { sys(`no other room matches '${targetArg}'`); break; }
      if (matches.length > 1) {
        sys(`ambiguous target '${targetArg}' — matches:`);
        for (const m of matches) sys(`  ${m.roomId}`);
        break;
      }
      target = matches[0];

      // Selector dispatch. We swap activeRoom to the target for the duration
      // of the bridged action, run the same handleCommand path that a local
      // tab would use, then restore. The bridged action lands in the target
      // room with the bridge peer's dyncap chain in *that* room — no new
      // wire kinds, no infrastructure relay.
      const runIn = (ctx: RoomContext, cmd: string): string[] => {
        const prev = activeRoom; setActiveRoom(ctx);
        try { return handleCommand(cmd); } finally { setActiveRoom(prev); }
      };

      if (selector.startsWith("@")) {
        const lemmaName = parseLemmaNameArg(selector);
        const entry = lemmaStore.get(lemmaName);
        if (!entry) { sys(`you don't hold ${lemmaRefStr(lemmaName)} in this room — nothing to share`); break; }
        sys(`· sharing ${lemmaRefStr(lemmaName)} → ${shortId(target.roomId)}`);
        runIn(target, `/lemma ${lemmaArgStr(lemmaName)} ${entry.twists}`);
      } else if (selector.startsWith("msg ")) {
        const text = selector.slice(4);
        sys(`· sharing chat → ${shortId(target.roomId)}`);
        // Direct chat envelope; this is the only path that doesn't reuse a
        // dispatcher command (because chat doesn't have one). Send it raw
        // through the target room's qpeer if connected.
        if (target.qpeer) {
          target.qpeer.broadcast({ kind: "chat", text });
          // Also reflect into the target's local chat log so the bridge peer
          // sees what they sent.
          const prev = activeRoom; setActiveRoom(target);
          try { addMessage("", text, "self"); } finally { setActiveRoom(prev); }
        } else {
          sys(`  · target room not connected — message not sent`);
        }
      } else if (selector.startsWith("note ")) {
        const noteParts = selector.slice(5).trim().split(/\s+/);
        const currency = noteParts[0];
        const N = parseInt(noteParts[1] ?? "", 10);
        if (!currency || isNaN(N) || N < 1) {
          sys("usage: /share note <currency> <N> to <room-prefix>");
          break;
        }
        sys(`· minting ${currency} ${N} in ${shortId(target.roomId)} (requires target to hold cap:token-${currency})`);
        runIn(target, `/note grant ${currency} ${N}`);
      } else {
        sys(`unknown selector: '${selector}'`);
        sys("  selectors: @<lemma>  |  msg <text>  |  note <currency> <N>");
        sys("  example: /share @met-bob to 02460246");
      }
      break;
    }

    case "room": {
      const rParts = arg.trim().split(/\s+/);
      const sub = (rParts[0] || "list").toLowerCase();
      if (sub === "list" || sub === "") {
        const room = activeRoom.roomId;
        const tw = tokenTwists(room);
        sys(`active room: ${room}`);
        if (tw) {
          const { pos, neg, gap, balanced } = twistStats(tw);
          sys(`  twists: ${tw.length}  (${pos} pos, ${neg} neg)  gap: ${gap}  ZFA: ${balanced ? "✓" : "✗"}`);
        }
        sys(`joined rooms (${rooms.size}):`);
        for (const ctx of rooms.values()) {
          const active = ctx.roomId === activeRoom.roomId ? " ←" : "";
          const connected = ctx.qpeer ? "  ●" : "";
          sys(`  ${shortId(ctx.roomId)}  ${ctx.roomId}${connected}${active}`);
        }
      } else if (sub === "join") {
        const target = rParts.slice(1).join(" ").trim();
        const roomId = extractRoomCap(target);
        if (!roomId) { sys("usage: /room join <cap:room:…> | <share-url>"); break; }
        if (!validateCapability(roomId)) { sys(`invalid room cap (not ZFA-balanced): ${roomId}`); break; }
        openRoomTab(roomId);
        sys(`joined room ${shortId(roomId)} (switched to new tab)`);
      } else if (sub === "leave") {
        if (rooms.size <= 1) { sys("cannot leave the last room"); break; }
        const leavingId = activeRoom.roomId;
        closeRoomTab(leavingId);
        sys(`left room ${shortId(leavingId)}`);
      } else if (sub === "ref") {
        const target = rParts.slice(1).join(" ").trim();
        const roomId = extractRoomCap(target) || activeRoom.roomId;
        sys(`room: ${roomId}`);
        sys(`  share URL: ${window.location.origin}${window.location.pathname}#room=${roomId}`);
      } else {
        sys(`unknown subcommand: /room ${sub}`);
        sys("  /room list                       — list joined rooms");
        sys("  /room join <cap:room:…|url>      — open a new tab for the named room");
        sys("  /room leave                      — close the active tab");
        sys("  /room ref [cap:room:…]           — print a shareable URL for a room");
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
    setQpeer(null);
    peers.clear();
    peerNames.clear();
    renderPeers();
    if (isUiActive()) {
      msgInput.disabled = true;
      sendBtn.disabled = true;
      connectBtn.textContent = "Connect";
    }
    setStatus("disconnected", "disconnected");
    return;
  }

  // Capture the room being connected. All this QOSPeer's callbacks
  // operate against this context regardless of which tab the user is
  // looking at when the callback fires; setActiveRoom(ctx) at callback
  // entry temporarily redirects the module-level state aliases so
  // mutations land in this room, and DOM-touching code further guards
  // with isUiActive() so the visible tab isn't disturbed.
  const ctx = activeRoom;
  const roomId = ctx.roomId;
  const signalingUrl = signalUrlEl.value.trim() || DEFAULT_SIGNAL;
  ctx.signalingUrl = signalingUrl;
  const stunUrl = stunUrlEl.value.trim();

  setStatus("connecting", "connecting… (first connect may take ~30s to wake server)");
  connectBtn.textContent = "Disconnect";

  const newPeer = new QOSPeer({
    signalingUrl,
    roomId,
    iceServers: stunUrl ? [{ urls: stunUrl }] : undefined,
    onSignalingOpen() {
      const prev = activeRoom; setActiveRoom(ctx);
      try {
        setStatus("connected", `connected · ${signalingUrl}`);
        if (isUiActive()) {
          msgInput.disabled = false;
          sendBtn.disabled = false;
          toggleSidebar(false);
        }
        renderPeers();
        // Log the join only once per room. onSignalingOpen also fires on every
        // signaling reconnect (e.g. a backgrounded tab dropped by the server's
        // heartbeat), so logging here unconditionally floods the room with
        // "joined room" lines. The persistent connected status already reflects
        // reconnects.
        if (!ctx.hasJoinedOnce) {
          addMessage("", `joined room ${shortId(roomId)}`, "system");
          ctx.hasJoinedOnce = true;
        }
        openProbeWindow();
      } finally { setActiveRoom(prev); }
    },
    onSignalingClose() {
      const prev = activeRoom; setActiveRoom(ctx);
      try {
        setStatus("connecting", "reconnecting…");
        if (isUiActive()) {
          msgInput.disabled = true;
          sendBtn.disabled = true;
        }
      } finally { setActiveRoom(prev); }
    },
    async onMessage(from, data) {
      const prev = activeRoom; setActiveRoom(ctx);
      try {
      if (typeof data === "object" && data !== null) {
        const d = data as Record<string, unknown>;
        if (d.kind === "name") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          peerNames.set(from, String(d.name ?? ""));
          renderPeers();
          if (status) addMessage("", `${peerLabel(from)} ${status.trim()}`, "system");
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
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) {
            addMessage(from, `/lemma ${String(d.name ?? "")}`, "peer", peerLabel(from));
            addMessage("", status, "system");
            return;
          }
          const name = canonLemma(String(d.name ?? ""));
          const twists = String(d.twists ?? "").trim();
          const cap = d.cap ? String(d.cap) : undefined;
          const who = peerLabel(from);
          const dyncap = (d.dyncap as DyncapField | undefined);
          // Lemmas are content-addressed by name. First-write-wins: if we
          // already have @name with different twists, refuse the new claim
          // and surface the disagreement; the consensus probe will catch up.
          const existing = lemmaStore.get(name);
          if (existing && existing.twists !== twists) {
            addMessage(from, `/lemma ${lemmaArgStr(name)} ${twists}`, "peer", who);
            addMessage("", `  ⚠ refused: ${lemmaRefStr(name)} already declared with different twists (${existing.twists})`, "system");
            return;
          }
          if (existing && existing.twists === twists) {
            return;   // idempotent re-broadcast, silent
          }
          if (name && twists) {
            lemmaStore.set(name, { twists, who, cap, dyncap });
            addMessage(from, `/lemma ${lemmaArgStr(name)} ${twists}`, "peer", who);
            addMessage("", `  ${lemmaRefStr(name)} registered from ${who}${cap ? `  [cap: ${cap}]` : ""}${dyncap ? `  [signed seq=${dyncap.seq}]` : ""}`, "system");
            saveLemmas();
            renderLemmas();
          }
          return;
        }
        if (d.kind === "lemma-request") {
          const name = canonLemma(String(d.name ?? ""));
          const fromName = String(d.fromName ?? peerLabel(from));
          addMessage(from, `requests ${lemmaRefStr(name)}`, "peer", fromName);
          if (lemmaStore.has(name)) {
            addMessage("", `  · you hold ${lemmaRefStr(name)} — type /pass ${lemmaArgStr(name)} ${fromName} to transfer`, "system");
          }
          return;
        }
        if (d.kind === "lemma-pass") {
          const name = canonLemma(String(d.name ?? ""));
          const twists = String(d.twists ?? "").trim();
          const cap = d.cap ? String(d.cap) : undefined;
          const who = peerLabel(from);
          if (name && twists) {
            lemmaStore.set(name, { twists, who, cap });
            saveLemmas();
            renderLemmas();
            addMessage(from, `passes ${lemmaRefStr(name)}`, "peer", who);
            addMessage("", `  · ${lemmaRefStr(name)} received from ${who}${cap ? `  [cap: ${cap}]` : ""}`, "system");
            if (cap) addMessage("", `  · run /zfa ${cap} to verify`, "system");
          }
          return;
        }
        if (d.kind === "note-declare") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) {
            addMessage(from, `/note declare ${String(d.currency ?? "")}`, "peer", peerLabel(from));
            addMessage("", status, "system");
            return;
          }
          const currency = String(d.currency ?? "");
          const token    = String(d.token ?? "");
          const who      = peerLabel(from);
          const dyncap   = (d.dyncap as DyncapField | undefined);
          addMessage(from, `/note declare ${currency}`, "peer", who);
          const parsed = parseNoteLabel(token);
          const valid  = parsed?.kind === "token" && parsed.currency === currency && validateCapability(token);
          if (!valid) {
            addMessage("", `  · refused: malformed currency authority token`, "system");
            return;
          }
          if (!knownCurrencies.has(token)) {
            knownCurrencies.set(token, { currency, token, issuer: who, dyncap });
            saveNotes();
            renderNotes();
          }
          addMessage("", `  · ${who} issues ${currency}  authority: ${token}${dyncap ? `  [signed seq=${dyncap.seq}]` : ""}`, "system");
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
          if (ignoredForSync.has(from)) {
            addMessage("", `  · dropped sync-lemmas from ${peerLabel(from)} (ignored: losing observer)`, "system");
            return;
          }
          const entries = raw as Array<{ name?: string; twists?: string; who?: string; cap?: string; dyncap?: DyncapField }>;
          const who = peerLabel(from);
          // Record observations for the probe window even when we also apply.
          // Pair with sync-currencies if it arrives in the same handshake.
          if (probe.open) recordSyncObservations(from, entries, []);
          let added = 0;
          for (const e of entries) {
            const name   = canonLemma(String(e.name ?? ""));
            const twists = String(e.twists ?? "").trim();
            if (!name || !twists) continue;
            if (lemmaStore.has(name)) continue;
            const tw = resolveLemmaToBytes(twists);
            if (!tw || !achievesZfa(tw)) continue;
            lemmaStore.set(name, { twists, who: e.who || who, cap: e.cap, dyncap: e.dyncap });
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
          if (ignoredForSync.has(from)) {
            addMessage("", `  · dropped sync-currencies from ${peerLabel(from)} (ignored: losing observer)`, "system");
            return;
          }
          const entries = raw as Array<{ currency?: string; token?: string; issuer?: string; dyncap?: DyncapField }>;
          const who = peerLabel(from);
          if (probe.open) recordSyncObservations(from, [], entries);
          let added = 0;
          for (const e of entries) {
            const currency = String(e.currency ?? "").trim();
            const token    = String(e.token    ?? "").trim();
            if (!currency || !token) continue;
            if (knownCurrencies.has(token)) continue;
            const parsed = parseNoteLabel(token);
            if (!parsed || parsed.kind !== "token" || parsed.currency !== currency) continue;
            if (!validateCapability(token)) continue;
            knownCurrencies.set(token, { currency, token, issuer: e.issuer || who, dyncap: e.dyncap });
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
        if (d.kind === "state-discrepancy") {
          await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          const storeName = String(d.storeName ?? "");
          const key       = String(d.key       ?? "");
          const obsRaw    = d.observations;
          const observations = Array.isArray(obsRaw) ? obsRaw as Array<{ peers: string[]; count: number; weight: number }> : [];
          const winnerLeader = observations[0];
          const tally = winnerLeader
            ? `weight ${winnerLeader.weight} vs ${observations.slice(1).map(o => o.weight).join(", ")} · ${winnerLeader.count} vs ${observations.slice(1).map(o => o.count).join(", ")} peers`
            : "no observations";
          addMessage(from, `⚠ discrepancy on ${storeName}/${key}`, "peer", peerLabel(from));
          if (d.winner === null || d.winner === undefined) {
            addMessage("", `  · contested by ${peerLabel(from)} (no supermajority); ${tally}`, "system");
          } else {
            addMessage("", `  · supermajority winner declared by ${peerLabel(from)}; ${tally}`, "system");
          }
          return;
        }
        if (d.kind === "rdv-propose") {
          const proposalRaw = d.proposal;
          if (!proposalRaw || typeof proposalRaw !== "object") return;
          const proposal = proposalRaw as Proposal;
          if (!proposal.id || !Array.isArray(proposal.rows) || typeof proposal.expiresAt !== "number") return;
          if (proposal.expiresAt < Date.now()) return;
          if (!conservationCheck(proposal.rows)) {
            addMessage(from, `proposes rendezvous`, "peer", peerLabel(from));
            addMessage("", `  · refused: conservation violation`, "system");
            return;
          }
          if (proposals.has(proposal.id)) return;
          const myId = qpeer?.peerId ?? "";
          const myRow = proposal.rows.find(r => r.participant === myId);
          if (!myRow) return;
          proposals.set(proposal.id, {
            proposal, role: "participant", myStatus: "pending",
            acceptedBy: new Map(),
          });
          scheduleProposalTimeout(proposal.id, proposal.expiresAt - Date.now());
          saveNotes();
          renderNotes();
          addMessage(from, `proposes rendezvous ${shortRdvId(proposal.id)}`, "peer", peerLabel(from));
          addMessage("", `  · you give ${myRow.gives.currency} ${myRow.gives.denomination}, get ${myRow.gets.currency} ${myRow.gets.denomination}`, "system");
          addMessage("", `  · /rdv accept ${shortRdvId(proposal.id)}   or   /rdv reject ${shortRdvId(proposal.id)}`, "system");
          return;
        }
        if (d.kind === "rdv-accept") {
          const id = String(d.id ?? "");
          const token = String(d.token ?? "");
          const state = proposals.get(id);
          if (!state || state.role !== "proposer") return;
          const senderRow = state.proposal.rows.find(r => r.participant === from);
          if (!senderRow) return;
          const parsed = parseNoteLabel(token);
          if (!parsed || parsed.kind !== "note"
              || parsed.currency !== senderRow.gives.currency
              || noteDenomination(token) !== senderRow.gives.denomination
              || !validateCapability(token)) {
            addMessage(from, `accepts rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
            addMessage("", `  · refused: token mismatch or invalid`, "system");
            return;
          }
          state.acceptedBy.set(from, token);
          addMessage(from, `accepts rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
          const participants = uniqueParticipants(state.proposal);
          if (!participants.every(p => state.acceptedBy.has(p))) return;

          // All accepted — build commit (cyclic: row[i].gets = next row's gives)
          const N = state.proposal.rows.length;
          const commitRows: CommitRow[] = state.proposal.rows.map((r, i) => {
            const nextRow = state.proposal.rows[(i + 1) % N];
            return {
              participant: r.participant,
              givesToken: state.acceptedBy.get(r.participant)!,
              getsToken:  state.acceptedBy.get(nextRow.participant)!,
            };
          });
          const self = qpeer?.peerId ?? "";
          if (qpeer) {
            for (const p of participants) {
              if (p === self) continue;
              qpeer.send(p, { kind: "rdv-commit", id, rows: commitRows });
            }
          }
          const ok = applyCommit(state, commitRows);
          proposals.delete(id);
          clearProposalTimeout(id);
          saveNotes();
          renderNotes();
          addMessage("", ok ? `  · committed rdv ${shortRdvId(id)}` : `  · commit application failed locally`, "system");
          return;
        }
        if (d.kind === "rdv-reject") {
          const id = String(d.id ?? "");
          const state = proposals.get(id);
          if (!state || state.role !== "proposer") return;
          addMessage(from, `rejects rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
          releaseLockedFor(id);
          if (qpeer) {
            const self = qpeer.peerId;
            const targets = uniqueParticipants(state.proposal).filter(p => p !== self && p !== from);
            for (const t of targets) qpeer.send(t, { kind: "rdv-abort", id, reason: "peer-rejected" });
          }
          proposals.delete(id);
          clearProposalTimeout(id);
          saveNotes();
          renderNotes();
          addMessage("", `  · rdv ${shortRdvId(id)} aborted`, "system");
          return;
        }
        if (d.kind === "rdv-commit") {
          const id = String(d.id ?? "");
          const rowsRaw = d.rows;
          if (!Array.isArray(rowsRaw)) return;
          const commitRows = rowsRaw as CommitRow[];
          const state = proposals.get(id);
          if (!state || state.role !== "participant") return;
          if (state.myStatus !== "accepted") return;
          const ok = applyCommit(state, commitRows);
          proposals.delete(id);
          clearProposalTimeout(id);
          saveNotes();
          renderNotes();
          addMessage(from, `commits rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
          addMessage("", ok ? `  · rdv ${shortRdvId(id)} settled` : `  · commit application failed`, "system");
          return;
        }
        if (d.kind === "rdv-abort") {
          const id = String(d.id ?? "");
          const reason = String(d.reason ?? "");
          const state = proposals.get(id);
          if (!state) return;
          releaseLockedFor(id);
          proposals.delete(id);
          clearProposalTimeout(id);
          saveNotes();
          renderNotes();
          addMessage(from, `aborts rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
          addMessage("", `  · rdv ${shortRdvId(id)} cancelled${reason ? ` (${reason})` : ""}`, "system");
          return;
        }
        if (d.kind === "rdv-counter") {
          // The other participant proposed new terms for an in-flight rdv.
          // Validate, release any locks we hold for it (terms changed —
          // any token we had reserved is no longer the right one), and
          // replace the proposal's rows. Our status resets to pending; the
          // counterer's status is "accepted" (acceptedBy tracks them).
          const id = String(d.id ?? "");
          const rowsRaw = d.rows;
          if (!Array.isArray(rowsRaw)) return;
          const newRows = rowsRaw as Row[];
          const state = proposals.get(id);
          if (!state) {
            addMessage(from, `counters rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
            addMessage("", `  · refused: no matching proposal`, "system");
            return;
          }
          if (!conservationCheck(newRows)) {
            addMessage(from, `counters rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
            addMessage("", `  · refused: conservation violation`, "system");
            return;
          }
          const myId = qpeer?.peerId ?? "";
          const myNewRow = newRows.find(r => r.participant === myId);
          if (!myNewRow) {
            addMessage(from, `counters rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
            addMessage("", `  · refused: I have no row in the new terms`, "system");
            return;
          }

          // Validate the counterer's committed token: must be a real note
          // matching their new row's gives spec, and ZFA-balanced.
          const counterToken = String(d.token ?? "");
          const senderRow = newRows.find(r => r.participant === from);
          if (!senderRow) {
            addMessage(from, `counters rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
            addMessage("", `  · refused: counterer has no row in new terms`, "system");
            return;
          }
          const parsedTok = parseNoteLabel(counterToken);
          if (!parsedTok || parsedTok.kind !== "note"
              || parsedTok.currency !== senderRow.gives.currency
              || noteDenomination(counterToken) !== senderRow.gives.denomination
              || !validateCapability(counterToken)) {
            addMessage(from, `counters rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
            addMessage("", `  · refused: counterer's token doesn't match new terms`, "system");
            return;
          }

          // Release any locks held for the previous round.
          releaseLockedFor(id);
          state.acceptedBy.clear();
          state.acceptedBy.set(from, counterToken);   // counterer implicitly accepted with this token
          state.proposal.rows = newRows;
          state.proposal.proposerName = String(d.proposerName ?? peerLabel(from));
          state.proposal.expiresAt = Date.now() + RDV_TIMEOUT_MS;
          state.myStatus = "pending";
          clearProposalTimeout(id);
          scheduleProposalTimeout(id, RDV_TIMEOUT_MS);
          saveNotes();
          renderNotes();

          addMessage(from, `counters rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
          addMessage("", `  · new terms: you give ${myNewRow.gives.currency} ${myNewRow.gives.denomination}, get ${myNewRow.gets.currency} ${myNewRow.gets.denomination}`, "system");
          addMessage("", `  · /rdv accept ${shortRdvId(id)}  |  /rdv reject ${shortRdvId(id)}  |  /rdv counter ${shortRdvId(id)} <giveCur> <giveN> <getCur> <getN>`, "system");
          return;
        }
        if (d.kind === "persist-request") {
          const id = String(d.id ?? "");
          const persistKind = String(d.persistKind ?? "");
          const fromName = String(d.fromName ?? peerLabel(from));
          if (!id || (persistKind !== "lemma" && persistKind !== "currency")) return;
          const req: PersistRequest = {
            id, kind: persistKind as PersistKind,
            fromPeer: from, fromName,
          };
          if (persistKind === "lemma") {
            req.lemmaName = String(d.lemmaName ?? "");
            req.lemmaEntry = d.lemmaEntry as LemmaEntry | undefined;
            if (!req.lemmaName || !req.lemmaEntry?.twists) return;
            addMessage(from, `requests you persist @${req.lemmaName}`, "peer", fromName);
            addMessage("", `  · twists: ${req.lemmaEntry.twists}${req.lemmaEntry.cap ? `  [cap: ${req.lemmaEntry.cap}]` : ""}`, "system");
          } else {
            req.currencyToken = String(d.currencyToken ?? "");
            req.currencyEntry = d.currencyEntry as KnownCurrency | undefined;
            if (!req.currencyToken || !req.currencyEntry?.currency) return;
            addMessage(from, `requests you persist currency ${req.currencyEntry.currency}`, "peer", fromName);
            addMessage("", `  · authority: ${req.currencyToken.slice(0, 24)}…  (issued by ${req.currencyEntry.issuer})`, "system");
          }
          pendingPersistRequests.set(id, req);
          addMessage("", `  · /persist accept ${id.slice(0, 8)}  or  /persist reject ${id.slice(0, 8)}`, "system");
          return;
        }
        if (d.kind === "channel-msg") {
          const ch = String(d.channel ?? "");
          const payload = String(d.payload ?? "");
          // Subscribed channels surface in chat; unsubscribed channels are
          // silently dropped — the tagged broadcast is a public envelope but
          // the filter is per-receiver.
          if (channelSubscriptions.has(ch)) {
            addMessage(from, `[#${ch}] ${payload}`, "peer", peerLabel(from));
          }
          // RhoQu `on channel(x) { … }` handlers fire on every matching
          // channel-msg regardless of subscription. Each fires once per
          // delivery; the body runs with `x` bound to the payload.
          for (const h of rhoquHandlers) {
            if (h.channel !== ch) continue;
            try {
              const cmds = h.trigger(payload);
              if (cmds.length === 0) continue;
              addMessage("", `  · rhoqu on ${ch}(${h.binding}=${payload}) → ${cmds.length} cmd${cmds.length === 1 ? "" : "s"}`, "system");
              for (const c of cmds) {
                try { handleCommand(c); }
                catch (err) { addMessage("", `  · rhoqu trigger error: ${String(err)}`, "system"); }
              }
            } catch (err) {
              addMessage("", `  · rhoqu on-handler error for ${ch}: ${String(err)}`, "system");
            }
          }
          return;
        }
        if (d.kind === "poll-open") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const id = String(d.id ?? "");
          if (!id || pollStore.has(id)) return;                    // idempotent
          const options: PollOption[] = [];
          if (Array.isArray(d.options)) {
            for (const o of d.options as unknown[]) {
              if (o && typeof o === "object") {
                const r = o as Record<string, unknown>;
                const text = String(r.text ?? "").trim();
                if (!text) continue;
                options.push({ id: String(r.id ?? optionId(text)), text, by: String(r.by ?? "?"), at: typeof r.at === "number" ? r.at : Date.now() });
              }
            }
          }
          const poll: Poll = {
            id, question: String(d.question ?? ""), options,
            method: d.method === "ranked" ? "ranked" : "approval",
            creator: from, creatorLabel: String(d.creatorLabel ?? peerLabel(from)),
            createdAt: typeof d.createdAt === "number" ? d.createdAt : Date.now(),
            status: "open", ballots: {},
          };
          flushBufferedOptions(poll);                              // out-of-order options
          flushBufferedBallots(poll);                              // out-of-order ballots
          pollStore.set(id, poll);
          savePolls();
          renderPolls();
          addPollCard(poll);
          return;
        }
        if (d.kind === "poll-option") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const pollId = String(d.pollId ?? "");
          const text = String(d.text ?? "").trim();
          if (!text) return;
          const opt: PollOption = {
            id: String(d.id ?? optionId(text)), text,
            by: String(d.by ?? peerLabel(from)),
            at: typeof d.at === "number" ? d.at : Date.now(),
          };
          const poll = pollStore.get(pollId);
          if (!poll) { bufferOption(pollId, opt); return; }            // arrived before poll-open
          if (poll.nominationsLocked || poll.status === "closed") return;
          if (!mergeOption(poll, opt)) return;                         // duplicate
          savePolls();
          refreshPollCard(poll);
          renderPolls();
          return;
        }
        if (d.kind === "poll-lock") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const poll = pollStore.get(String(d.pollId ?? ""));
          if (!poll || from !== poll.creator) return;
          poll.nominationsLocked = true;
          savePolls();
          refreshPollCard(poll);
          return;
        }
        if (d.kind === "poll-ballot") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const pollId = String(d.pollId ?? "");
          const choices = Array.isArray(d.choices)
            ? (d.choices as unknown[]).map(String).filter((x) => x.length > 0) : [];
          const poll = pollStore.get(pollId);
          if (!poll) { bufferBallot(pollId, from, choices); return; }   // arrived before poll-open
          if (poll.status === "closed") return;                        // late ballot ignored
          poll.ballots[from] = choices;                                // latest wins
          savePolls();
          refreshPollCard(poll);
          renderPolls();
          return;
        }
        if (d.kind === "poll-close") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const poll = pollStore.get(String(d.pollId ?? ""));
          if (!poll || poll.status === "closed") return;               // idempotent
          if (from !== poll.creator) return;                           // only creator closes
          poll.status = "closed";
          poll.result = tally(poll);
          savePolls();
          refreshPollCard(poll);
          renderPolls();
          postPollClosedMessage(poll);
          return;
        }
        if (d.kind === "sync-polls") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          if (!Array.isArray(d.polls)) return;
          let added = 0, updated = 0;
          for (const raw of d.polls as unknown[]) {
            const r = mergePollFromSync(raw);
            if (r === "added") { added++; const p = pollStore.get(String((raw as Record<string, unknown>).id)); if (p) { addPollCard(p); if (p.status === "closed") postPollClosedMessage(p); } }
            else if (r === "updated") { updated++; const p = pollStore.get(String((raw as Record<string, unknown>).id)); if (p) refreshPollCard(p); }
          }
          if (added > 0 || updated > 0) {
            savePolls();
            renderPolls();
            if (added > 0) addMessage("", `  · synced ${added} poll${added === 1 ? "" : "s"} from ${peerLabel(from)}`, "system");
          }
          return;
        }
        if (d.kind === "file-start") { handleFileStart(d); return; }
        if (d.kind === "file-chunk") { handleFileChunk(from, d); return; }
        if (d.kind === "call-start") {
          addMessage("", `📞 ${peerLabel(from)} started a call — click Call to join`, "system");
          return;
        }
        if (d.kind === "call-end") {
          removeTile(from);
          maybeHideCallBar();
          addMessage("", `📵 ${peerLabel(from)} left the call`, "system");
          return;
        }
        if (d.kind === "chat" || "text" in d) {
          const text = "text" in d ? String(d.text) : String(d.message ?? JSON.stringify(d));
          addMessage(from, text, "peer", peerLabel(from));
          return;
        }
      }
      addMessage(from, JSON.stringify(data), "peer", peerLabel(from));
      } finally { setActiveRoom(prev); }
    },
    onChannelOpen(peerId) {
      const prev = activeRoom; setActiveRoom(ctx);
      try {
        signedSend(peerId, { kind: "name", name: myName });
        if (lemmaStore.size > 0) {
          const entries = Array.from(lemmaStore.entries()).map(([name, e]) => ({
            name, twists: e.twists, who: e.who, cap: e.cap, dyncap: e.dyncap,
          }));
          signedSend(peerId, { kind: "sync-lemmas", entries });
        }
        if (knownCurrencies.size > 0) {
          const entries = Array.from(knownCurrencies.values());
          signedSend(peerId, { kind: "sync-currencies", entries });
        }
        if (pollStore.size > 0) {
          const polls = Array.from(pollStore.values());
          signedSend(peerId, { kind: "sync-polls", polls });
        }
      } finally { setActiveRoom(prev); }
    },
    onPeerJoined(id) {
      const prev = activeRoom; setActiveRoom(ctx);
      try {
        const pending = pendingLeaves.get(id);
        if (pending !== undefined) {
          clearTimeout(pending);
          pendingLeaves.delete(id);
          peers.add(id);
          renderPeers();
          return;
        }
        if (peers.has(id)) return;
        peers.add(id);
        renderPeers();
        addMessage("", `${peerLabel(id)} joined`, "system");
      } finally { setActiveRoom(prev); }
    },
    onPeerLeft(id) {
      // The setTimeout fires later — capture ctx in the closure so the
      // delayed work runs against the right room even if activeRoom has
      // changed in the meantime.
      const timer = setTimeout(() => {
        const prev = activeRoom; setActiveRoom(ctx);
        try {
          pendingLeaves.delete(id);
          peers.delete(id);
          renderPeers();
          addMessage("", `${peerLabel(id)} left`, "system");
          peerNames.delete(id);
          removeTile(id);
          maybeHideCallBar();
        } finally { setActiveRoom(prev); }
      }, 6_000);
      // The pendingLeaves mutation happens synchronously; wrap it too.
      const prev = activeRoom; setActiveRoom(ctx);
      try { pendingLeaves.set(id, timer); } finally { setActiveRoom(prev); }
    },
    onRemoteTrack(peerId, stream) {
      const prev = activeRoom; setActiveRoom(ctx);
      try { if (isUiActive()) addRemoteStream(peerId, stream); }
      finally { setActiveRoom(prev); }
    },
  });
  setQpeer(newPeer);
  newPeer.connect();
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
    if (lines.length > 0 && cmd !== "help" && cmd !== "grant" && cmd !== "lemma" && cmd !== "note" && cmd !== "rdv" && cmd !== "dyncap" && cmd !== "probe" && cmd !== "room" && cmd !== "share" && cmd !== "channel" && cmd !== "script" && cmd !== "persist" && cmd !== "rhoqu") {
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
// Rich text (safe Markdown subset) + persistent chat transcript
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A deliberately small, XSS-safe Markdown renderer: everything is HTML-escaped
 *  first, then a fixed set of tags is re-introduced. No raw peer HTML is ever
 *  inserted, and link hrefs are constrained to http(s). */
function renderMarkdown(src: string): string {
  const codes: string[] = [];
  let s = escapeHtml(src);
  // fenced code blocks ``` … ``` (protect from further formatting)
  s = s.replace(/```([\s\S]*?)```/g, (_m, c: string) => {
    codes.push(`<pre class="code">${c.replace(/^\n/, "").replace(/\n$/, "")}</pre>`);
    return `@@@${codes.length - 1}@@@`;
  });
  // inline code `…`
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `@@@${codes.length - 1}@@@`;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g,
    '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  s = s.replace(/\n/g, "<br>");
  s = s.replace(/@@@(\d+)@@@/g, (_m, i: string) => codes[Number(i)]);
  return s;
}

function loadChat(roomId: string): ChatLine[] {
  try {
    const raw = localStorage.getItem(`qos-chat-${roomId}`);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveChat(room: RoomContext): void {
  try {
    // Persist the transcript, but drop large media data-URLs (they'd blow the
    // localStorage quota). A media line reloads as a labelled placeholder.
    const slim = room.chatLog.slice(-200).map((l) =>
      l.media ? { ...l, media: { ...l.media, url: "" } } : l);
    localStorage.setItem(`qos-chat-${room.roomId}`, JSON.stringify(slim));
  } catch { /* storage quota — drop silently */ }
}

// ---------------------------------------------------------------------------
// Attachments: images / audio / video / files over the data channel (chunked)
// ---------------------------------------------------------------------------

const FILE_MAX = 8 * 1024 * 1024;     // 8 MB hard cap per attachment
const FILE_CHUNK = 16 * 1024;         // base64 chars per data-channel message
let fileSeq = 0;

function fmtSize(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

function mediaKindOf(mime: string, name: string): MediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(ext)) return "image";
  if (["mp3", "wav", "ogg", "m4a", "opus", "aac"].includes(ext)) return "audio";
  if (["mp4", "webm", "mov", "mkv"].includes(ext)) return "video";
  return "file";
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(bin);
}

/** Pause until the data-channel send buffers drain below ~1 MB. */
function paceSend(): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (!qpeer || qpeer.maxBufferedAmount() < (1 << 20)) resolve();
      else setTimeout(check, 30);
    };
    check();
  });
}

function renderMedia(host: HTMLElement, m: MediaAttachment): void {
  if (!m.url) {   // persisted placeholder (data-URL was stripped on save)
    const span = document.createElement("span");
    span.className = "media-file";
    span.textContent = `📎 ${m.name} (${fmtSize(m.size)})`;
    host.appendChild(span);
    return;
  }
  if (m.mediaKind === "image") {
    const img = document.createElement("img");
    img.className = "media-img"; img.src = m.url; img.alt = m.name; img.loading = "lazy";
    img.title = `${m.name} (${fmtSize(m.size)}) — click to open`;
    img.addEventListener("click", () => window.open(m.url, "_blank", "noopener"));
    host.appendChild(img);
  } else if (m.mediaKind === "audio") {
    const a = document.createElement("audio"); a.controls = true; a.src = m.url; a.preload = "metadata";
    host.appendChild(a);
  } else if (m.mediaKind === "video") {
    const v = document.createElement("video"); v.className = "media-vid"; v.controls = true; v.src = m.url; v.preload = "metadata";
    host.appendChild(v);
  } else {
    const a = document.createElement("a");
    a.className = "media-file"; a.href = m.url; a.download = m.name;
    a.textContent = `📎 ${m.name} (${fmtSize(m.size)})`;
    host.appendChild(a);
  }
}

function addMedia(from: string, media: MediaAttachment, kind: "peer" | "self", label?: string): void {
  const line: ChatLine = { from, text: "", kind, label, media };
  activeRoom.chatLog.push(line);
  trimChatLog(activeRoom);
  saveChat(activeRoom);
  if (isUiActive()) {
    renderChatLine(line);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    markUnread(activeRoom);
  }
}

async function sendFile(file: File): Promise<void> {
  if (!qpeer) { addMessage("", "connect to a room before sending attachments", "system"); return; }
  if (file.size > FILE_MAX) {
    addMessage("", `⚠ "${file.name}" is ${fmtSize(file.size)} — over the ${fmtSize(FILE_MAX)} attachment limit`, "system");
    return;
  }
  const buf = await file.arrayBuffer();
  const b64 = arrayBufferToBase64(buf);
  const mime = file.type || "application/octet-stream";
  const mediaKind = mediaKindOf(file.type, file.name);
  const id = `${qpeer.peerId.slice(-6)}-${Date.now()}-${fileSeq++}`;
  const total = Math.ceil(b64.length / FILE_CHUNK);
  qpeer.broadcast({ kind: "file-start", id, name: file.name, mime, size: file.size, total, mediaKind });
  for (let i = 0; i < total; i++) {
    qpeer.broadcast({ kind: "file-chunk", id, seq: i, data: b64.slice(i * FILE_CHUNK, (i + 1) * FILE_CHUNK) });
    if ((i & 31) === 31) await paceSend();
  }
  addMedia("", { mediaKind, name: file.name, mime, size: file.size, url: `data:${mime};base64,${b64}` }, "self");
}

function sendFiles(files: FileList | File[]): void {
  for (const f of Array.from(files)) void sendFile(f);
}

// Inbound reassembly: transfer id → partial state.
interface IncomingFile {
  name: string; mime: string; size: number; mediaKind: MediaKind;
  total: number; chunks: string[]; got: number;
}
const incomingFiles = new Map<string, IncomingFile>();

function handleFileStart(d: Record<string, unknown>): void {
  const id = String(d.id ?? "");
  const size = Number(d.size ?? 0);
  const total = Number(d.total ?? 0);
  if (!id || size > FILE_MAX || total <= 0 || total > Math.ceil(FILE_MAX / FILE_CHUNK) + 2) return;
  incomingFiles.set(id, {
    name: String(d.name ?? "file"),
    mime: String(d.mime ?? "application/octet-stream"),
    size,
    mediaKind: (d.mediaKind as MediaKind) ?? "file",
    total,
    chunks: new Array(total).fill(""),
    got: 0,
  });
}

function handleFileChunk(from: string, d: Record<string, unknown>): void {
  const id = String(d.id ?? "");
  const f = incomingFiles.get(id);
  if (!f) return;
  const seq = Number(d.seq ?? -1);
  if (seq < 0 || seq >= f.total || f.chunks[seq] !== "") return;
  f.chunks[seq] = String(d.data ?? "");
  f.got++;
  if (f.got >= f.total) {
    incomingFiles.delete(id);
    const url = `data:${f.mime};base64,${f.chunks.join("")}`;
    addMedia(from, { mediaKind: f.mediaKind, name: f.name, mime: f.mime, size: f.size, url }, "peer", peerLabel(from));
  }
}

// ---------------------------------------------------------------------------
// Self-evident UI: command palette, quick-action toolbar, onboarding
// ---------------------------------------------------------------------------

interface SlashCmd { name: string; template: string; desc: string }
const SLASH_COMMANDS: SlashCmd[] = [
  { name: "help",    template: "/help",       desc: "show all commands" },
  { name: "id",      template: "/id",         desc: "your peer ID and ZFA proof" },
  { name: "cap",     template: "/cap ",       desc: "generate a new ZFA capability" },
  { name: "grant",   template: "/grant ",     desc: "generate + share a capability token" },
  { name: "zfa",     template: "/zfa ",       desc: "validate a capability token" },
  { name: "braket",  template: "/braket ",    desc: "evaluate bra-ket (0 1 + - i -i)" },
  { name: "qucalc",  template: "/qucalc ",    desc: "evaluate a RhoQuCalc twist sequence" },
  { name: "conj",    template: "/conj ",      desc: "Hermitian adjoint of a twist sequence" },
  { name: "freq",    template: "/freq ",      desc: "ZFA frequency spectrum / C(2n,n)" },
  { name: "dump",    template: "/dump",       desc: "summary of logic shared this session" },
  { name: "lemma",   template: "/lemma ",     desc: "register / list named lemmas" },
  { name: "request", template: "/request ",   desc: "request a lemma from its holder" },
  { name: "pass",    template: "/pass ",      desc: "transfer a lemma to a named peer" },
  { name: "note",    template: "/note ",      desc: "promissory notes (grant|pass|redeem…)" },
  { name: "rdv",     template: "/rdv ",       desc: "atomic n-party swap (swap|accept…)" },
  { name: "poll",    template: "/poll ",      desc: "group vote (approval / ranked-choice)" },
  { name: "dyncap",  template: "/dyncap ",    desc: "dynamic capabilities (status|peers)" },
  { name: "probe",   template: "/probe ",     desc: "consensus discrepancy probe" },
  { name: "room",    template: "/room ",      desc: "multi-room tabs (list|join|leave)" },
  { name: "share",   template: "/share ",     desc: "bridge a lemma/note into another room" },
  { name: "channel", template: "/channel ",   desc: "tagged messages (listen|send|list)" },
  { name: "script",  template: "/script ",    desc: "run a sequential command chain" },
  { name: "persist", template: "/persist ",   desc: "agreed replication of public state" },
  { name: "rhoqu",   template: "/rhoqu ",     desc: "RhoQu macro → commands" },
];

interface QuickAction { label: string; ico: string; fill: string; hint: string }
const QUICK_ACTIONS: QuickAction[] = [
  { label: "Commands",   ico: "⌘", fill: "",                hint: "" },
  { label: "Call",       ico: "📞", fill: "",                hint: "" },
  { label: "Poll",       ico: "🗳", fill: "/poll new ",      hint: "e.g. /poll new Lunch?  — then everyone adds options & votes (add  | a, b  to seed)" },
  { label: "Capability", ico: "✦", fill: "/grant ",         hint: "name a capability, e.g. /grant alice-read" },
  { label: "Lemma",      ico: "≡", fill: "/lemma ",         hint: "name a lemma, e.g. /lemma mortality  (multi-word: /lemma [all men are mortal])" },
  { label: "Note",       ico: "$", fill: "/note grant ",    hint: "mint a note, e.g. /note grant USD 10" },
  { label: "Swap",       ico: "⇄", fill: "/rdv swap ",      hint: "atomic swap, e.g. /rdv swap USD 30 EUR 20 Alice" },
  { label: "Channel",    ico: "#", fill: "/channel send ",  hint: "tagged message, e.g. /channel send news hello" },
];

let cmdMenuEl: HTMLElement | null = null;
let actionsRowEl: HTMLElement | null = null;
let cmdSel = -1;
let cmdMatches: SlashCmd[] = [];

function cmdMenuOpen(): boolean { return !!cmdMenuEl && !cmdMenuEl.hidden; }
function hideCmdMenu(): void { if (cmdMenuEl) cmdMenuEl.hidden = true; cmdSel = -1; }

function showCmdMenu(filter: string, all = false): void {
  if (!cmdMenuEl) return;
  const f = filter.toLowerCase();
  cmdMatches = all ? SLASH_COMMANDS.slice() : SLASH_COMMANDS.filter((c) => c.name.startsWith(f));
  if (cmdMatches.length === 0) { hideCmdMenu(); return; }
  cmdMenuEl.innerHTML = "";
  cmdMatches.forEach((c, i) => {
    const item = document.createElement("div");
    item.className = "cmd-item" + (i === cmdSel ? " active" : "");
    const n = document.createElement("span"); n.className = "cmd-name"; n.textContent = "/" + c.name;
    const d = document.createElement("span"); d.className = "cmd-desc"; d.textContent = c.desc;
    item.appendChild(n); item.appendChild(d);
    item.addEventListener("mousedown", (e) => { e.preventDefault(); applyCmd(c); });
    cmdMenuEl!.appendChild(item);
  });
  cmdMenuEl.hidden = false;
}

function applyCmd(c: SlashCmd): void {
  msgInput.value = c.template;
  hideCmdMenu();
  msgInput.focus();
}

function moveCmdSel(delta: number): void {
  if (!cmdMenuEl || cmdMatches.length === 0) return;
  cmdSel = (cmdSel + delta + cmdMatches.length) % cmdMatches.length;
  Array.from(cmdMenuEl.children).forEach((el, i) => el.classList.toggle("active", i === cmdSel));
  (cmdMenuEl.children[cmdSel] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
}

function acceptCmd(): void {
  const pick = cmdSel >= 0 ? cmdMatches[cmdSel] : cmdMatches[0];
  if (pick) applyCmd(pick);
}

function showWelcome(): void {
  const div = document.createElement("div");
  div.className = "welcome";
  div.innerHTML =
    "<h3>⬡ Welcome to QuantumOS</h3>" +
    "A peer-to-peer room — no server holds your data. To get started:" +
    "<ol>" +
    "<li>Set a <strong>display name</strong> in the left sidebar.</li>" +
    "<li>Click <strong>Connect</strong>, then <strong>copy</strong> the share link and send it to a peer.</li>" +
    "<li>Type a message — <strong>Markdown</strong> works: <code>**bold**</code>, <code>*italic*</code>, <code>`code`</code>, links.</li>" +
    "<li>Use the <strong>action buttons</strong> above, or type <code>/</code> to browse every command.</li>" +
    "</ol>" +
    "<div class=\"tip\">Capabilities, lemmas, promissory notes and atomic swaps are all one click — or one slash — away.</div>";
  messagesEl.appendChild(div);
}

function initUx(): void {
  cmdMenuEl = document.getElementById("cmd-menu");
  actionsRowEl = document.getElementById("actions-row");

  if (actionsRowEl) {
    for (const a of QUICK_ACTIONS) {
      const btn = document.createElement("button");
      btn.className = "action-btn";
      btn.title = a.hint || "browse all commands";
      const ico = document.createElement("span"); ico.className = "ico"; ico.textContent = a.ico;
      btn.appendChild(ico);
      btn.appendChild(document.createTextNode(a.label));
      btn.addEventListener("click", () => {
        if (a.label === "Commands") {
          if (cmdMenuOpen()) hideCmdMenu();
          else { cmdSel = -1; showCmdMenu("", true); msgInput.focus(); }
          return;
        }
        if (a.label === "Call") { toggleCall(); return; }
        msgInput.value = a.fill;
        msgInput.focus();
        if (a.hint) addMessage("", a.hint, "system");
        hideCmdMenu();
      });
      actionsRowEl.appendChild(btn);
    }
  }

  // Autocomplete: surface matching commands while the user types the command word.
  msgInput.addEventListener("input", () => {
    const v = msgInput.value;
    if (v.startsWith("/") && !v.startsWith("//") && !v.includes(" ")) {
      cmdSel = -1;
      showCmdMenu(v.slice(1), false);
    } else {
      hideCmdMenu();
    }
  });
  msgInput.addEventListener("blur", () => setTimeout(hideCmdMenu, 120));

  // Attachments: picker button, drag-and-drop, clipboard paste.
  const attachBtn = document.getElementById("attach-btn");
  const fileInput = document.getElementById("file-input") as HTMLInputElement | null;
  if (attachBtn && fileInput) {
    attachBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files.length) sendFiles(fileInput.files);
      fileInput.value = "";
    });
  }
  const dropTarget = (messagesEl.closest(".main") as HTMLElement | null) ?? messagesEl;
  dropTarget.addEventListener("dragover", (e) => { e.preventDefault(); dropTarget.classList.add("dragover"); });
  dropTarget.addEventListener("dragleave", () => dropTarget.classList.remove("dragover"));
  dropTarget.addEventListener("drop", (e) => {
    e.preventDefault();
    dropTarget.classList.remove("dragover");
    if (e.dataTransfer?.files?.length) sendFiles(e.dataTransfer.files);
  });
  msgInput.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === "file") { const f = it.getAsFile(); if (f) files.push(f); }
    }
    if (files.length) { e.preventDefault(); sendFiles(files); }
  });

  // Live-call controls.
  callBarEl = document.getElementById("call-bar");
  callTilesEl = document.getElementById("call-tiles");
  callMuteBtn = document.getElementById("call-mute") as HTMLButtonElement | null;
  callCamBtn = document.getElementById("call-cam") as HTMLButtonElement | null;
  document.getElementById("call-hangup")?.addEventListener("click", endCall);
  callMuteBtn?.addEventListener("click", toggleMute);
  callCamBtn?.addEventListener("click", toggleCam);
}

// ---------------------------------------------------------------------------
// Polls: group decisions (approval / ranked-choice), dyncap-signed ballots,
// deterministic joiner-local tally
// ---------------------------------------------------------------------------

const RANK_CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];

// Out-of-order: ballots / options that arrive before their poll-open are buffered.
const pollBallotBuffer = new Map<string, Array<{ peer: string; choices: string[] }>>();
function bufferBallot(pollId: string, peer: string, choices: string[]): void {
  const arr = pollBallotBuffer.get(pollId) ?? [];
  arr.push({ peer, choices });
  pollBallotBuffer.set(pollId, arr);
}
function flushBufferedBallots(poll: Poll): void {
  const arr = pollBallotBuffer.get(poll.id);
  if (!arr) return;
  for (const { peer, choices } of arr) poll.ballots[peer] = choices;
  pollBallotBuffer.delete(poll.id);
}
const pollOptionBuffer = new Map<string, PollOption[]>();
function bufferOption(pollId: string, opt: PollOption): void {
  const arr = pollOptionBuffer.get(pollId) ?? [];
  arr.push(opt);
  pollOptionBuffer.set(pollId, arr);
}
function flushBufferedOptions(poll: Poll): void {
  const arr = pollOptionBuffer.get(poll.id);
  if (!arr) return;
  for (const o of arr) mergeOption(poll, o);
  pollOptionBuffer.delete(poll.id);
}

function myPeerId(): string { return qpeer?.peerId ?? "self"; }

function defaultOpenPoll(): Poll | null {
  let best: Poll | null = null;
  for (const p of pollStore.values()) {
    if (p.status === "open" && (!best || p.createdAt > best.createdAt)) best = p;
  }
  return best;
}
function findPoll(id?: string): Poll | null {
  return id ? (pollStore.get(id) ?? null) : defaultOpenPoll();
}

// Add/merge an option idempotently (dedupe by content id; keep earliest add-time).
function mergeOption(poll: Poll, opt: PollOption): boolean {
  const existing = poll.options.find((o) => o.id === opt.id);
  if (existing) { if (opt.at < existing.at) existing.at = opt.at; return false; }
  poll.options.push(opt);
  return true;
}

// Sanitize one inbound option object (sync / wire) into a PollOption, or null.
function coercePollOption(o: unknown): PollOption | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const text = String(r.text ?? "").trim();
  if (!text) return null;
  return {
    id: String(r.id ?? optionId(text)),
    text,
    by: String(r.by ?? "?"),
    at: typeof r.at === "number" ? r.at : 0,
  };
}

// Merge a whole poll received in a join handshake (sync-polls) into the store.
// New poll -> adopt verbatim (options, ballots, status, result, lock). Known
// poll -> union options (by id), adopt ballots only for peers we have none for
// (live poll-ballot envelopes reconcile re-votes), OR the lock flag, and adopt
// a closed result if the sender has closed it and we have not. Returns whether
// the poll was newly added, merely updated, or unchanged.
function mergePollFromSync(raw: unknown): "added" | "updated" | "none" {
  if (!raw || typeof raw !== "object") return "none";
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? "");
  if (!id) return "none";
  const inOpts = Array.isArray(r.options)
    ? (r.options as unknown[]).map(coercePollOption).filter((o): o is PollOption => o !== null)
    : [];
  const inBallots: Record<string, string[]> =
    r.ballots && typeof r.ballots === "object"
      ? Object.fromEntries(
          Object.entries(r.ballots as Record<string, unknown>).map(([peer, ch]) => [
            peer,
            Array.isArray(ch) ? (ch as unknown[]).map(String).filter((x) => x.length > 0) : [],
          ]),
        )
      : {};
  const inClosed = r.status === "closed";

  const existing = pollStore.get(id);
  if (!existing) {
    const poll: Poll = {
      id,
      question: String(r.question ?? ""),
      options: inOpts,
      method: r.method === "ranked" ? "ranked" : "approval",
      creator: String(r.creator ?? ""),
      creatorLabel: String(r.creatorLabel ?? "?"),
      createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
      status: inClosed ? "closed" : "open",
      nominationsLocked: r.nominationsLocked === true,
      ballots: inBallots,
    };
    flushBufferedOptions(poll);
    flushBufferedBallots(poll);
    if (inClosed) poll.result = tally(poll);
    pollStore.set(id, poll);
    return "added";
  }

  let changed = false;
  for (const opt of inOpts) if (mergeOption(existing, opt)) changed = true;
  for (const [peer, ch] of Object.entries(inBallots)) {
    if (!(peer in existing.ballots)) { existing.ballots[peer] = ch; changed = true; }
  }
  if (r.nominationsLocked === true && !existing.nominationsLocked) { existing.nominationsLocked = true; changed = true; }
  if (inClosed && existing.status !== "closed") {
    existing.status = "closed";
    existing.result = tally(existing);
    changed = true;
  }
  return changed ? "updated" : "none";
}

// Resolve a free-text choice list to option ids: option text (exact then prefix)
// or 1-based number into the displayed order. Ranked uses ">".
function resolveChoices(poll: Poll, raw: string): string[] {
  const opts = sortedOptions(poll);
  const parts = (poll.method === "ranked" ? raw.split(">") : raw.split(/[\s,]+/))
    .map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const tok of parts) {
    let opt: PollOption | undefined;
    if (/^\d+$/.test(tok)) {
      opt = opts[parseInt(tok, 10) - 1];
    } else {
      const low = tok.toLowerCase();
      opt = opts.find((o) => o.text.toLowerCase() === low) ?? opts.find((o) => o.text.toLowerCase().startsWith(low));
    }
    if (opt && !out.includes(opt.id)) out.push(opt.id);
  }
  return out;
}

function addOption(poll: Poll, text: string): void {
  const t = text.trim();
  if (!t) return;
  if (poll.status !== "open" || poll.nominationsLocked) { addMessage("", "nominations are closed for this poll", "system"); return; }
  const opt: PollOption = { id: optionId(t), text: t, by: myName || shortId(myPeerId()), at: Date.now() };
  if (!mergeOption(poll, opt)) return;          // duplicate — already present
  savePolls();
  refreshPollCard(poll);
  renderPolls();
  signedBroadcast({ kind: "poll-option", pollId: poll.id, id: opt.id, text: opt.text, by: opt.by, at: opt.at });
}

function castVote(poll: Poll, choices: string[]): void {
  if (poll.status !== "open") return;
  poll.ballots[myPeerId()] = choices;
  savePolls();
  refreshPollCard(poll);
  renderPolls();
  signedBroadcast({ kind: "poll-ballot", pollId: poll.id, choices });
}

function lockNominations(poll: Poll): void {
  if (poll.creator !== myPeerId() || poll.nominationsLocked) return;
  poll.nominationsLocked = true;
  savePolls();
  refreshPollCard(poll);
  signedBroadcast({ kind: "poll-lock", pollId: poll.id });
}

// Append a permanent, human-readable result line to the transcript so the
// outcome survives independently of the interactive card (chat scroll-back,
// the 500-line card cap, export). Idempotent callers ensure it logs once.
function postPollClosedMessage(poll: Poll): void {
  const result = poll.result ?? tally(poll);
  addMessage("", `🗳 poll closed — “${poll.question}” · ${summarizeWinners(poll, result)} (${result.totalBallots} vote${result.totalBallots === 1 ? "" : "s"})`, "system");
}

function closePoll(poll: Poll): void {
  if (poll.status !== "open") return;
  if (poll.creator !== myPeerId()) { addMessage("", "only the poll creator can close it", "system"); return; }
  poll.status = "closed";
  poll.result = tally(poll);
  savePolls();
  refreshPollCard(poll);
  renderPolls();
  postPollClosedMessage(poll);
  signedBroadcast({ kind: "poll-close", pollId: poll.id });
}

function createPoll(question: string, optionTexts: string[], method: PollMethod): void {
  const id = `poll-${myPeerId().slice(-4)}-${Date.now().toString(36)}`;
  const by = myName || shortId(myPeerId());
  const options: PollOption[] = optionTexts.map((t, k) => ({ id: optionId(t), text: t, by, at: Date.now() + k }));
  const poll: Poll = {
    id, question, options, method,
    creator: myPeerId(), creatorLabel: by,
    createdAt: Date.now(), status: "open", ballots: {},
  };
  pollStore.set(id, poll);
  savePolls();
  renderPolls();
  addPollCard(poll);
  signedBroadcast({
    kind: "poll-open", id, question, method, options,
    creator: poll.creator, creatorLabel: poll.creatorLabel, createdAt: poll.createdAt,
  });
}

function buildPollCard(poll: Poll): HTMLElement {
  const card = document.createElement("div");
  card.className = "poll-card";
  card.dataset.poll = poll.id;

  const q = document.createElement("div");
  q.className = "poll-q";
  q.textContent = poll.question + " ";
  const badge = document.createElement("span");
  badge.className = "poll-badge";
  badge.textContent = poll.method === "ranked" ? "ranked-choice" : "approval";
  q.appendChild(badge);
  if (poll.status === "closed") {
    const cl = document.createElement("span"); cl.className = "poll-badge"; cl.textContent = "closed"; q.appendChild(cl);
  } else if (!poll.nominationsLocked) {
    const op = document.createElement("span"); op.className = "poll-badge"; op.textContent = "open for ideas"; q.appendChild(op);
  }
  card.appendChild(q);

  const opts = sortedOptions(poll);
  const counts = liveCounts(poll);
  const maxCount = Math.max(1, ...Object.values(counts));
  const mine = poll.ballots[myPeerId()] ?? [];
  const result = poll.status === "closed" ? (poll.result ?? tally(poll)) : null;

  for (const opt of opts) {
    const row = document.createElement("div");
    row.className = "poll-opt";
    if (result && result.winners.includes(opt.id)) row.classList.add("winner");
    if (mine.includes(opt.id)) row.classList.add("voted");

    const bar = document.createElement("div");
    bar.className = "poll-bar";
    bar.style.width = `${Math.round(((counts[opt.id] ?? 0) / maxCount) * 100)}%`;
    row.appendChild(bar);

    if (poll.method === "ranked") {
      const rk = document.createElement("span");
      rk.className = "poll-rank";
      const pos = mine.indexOf(opt.id);
      rk.textContent = pos >= 0 ? (RANK_CIRCLED[pos] ?? `#${pos + 1}`) : "";
      row.appendChild(rk);
    }

    const label = document.createElement("span");
    label.style.flex = "1";
    label.textContent = opt.text;
    label.title = `suggested by ${opt.by}`;
    row.appendChild(label);

    const count = document.createElement("span");
    count.className = "poll-count";
    count.textContent = String(counts[opt.id] ?? 0);
    row.appendChild(count);

    if (poll.status === "open") {
      const btn = document.createElement("button");
      const isMine = mine.includes(opt.id);
      btn.textContent = poll.method === "approval"
        ? (isMine ? "✓ approved" : "approve")
        : (isMine ? "ranked" : "rank");
      btn.addEventListener("click", () => {
        const next = isMine ? mine.filter((x) => x !== opt.id) : [...mine, opt.id];
        castVote(poll, next);
      });
      row.appendChild(btn);
    }
    card.appendChild(row);
  }

  // "add an option" row — open nominations
  if (poll.status === "open" && !poll.nominationsLocked) {
    const addRow = document.createElement("div");
    addRow.className = "poll-add";
    const input = document.createElement("input");
    input.type = "text"; input.placeholder = "add an option…"; input.className = "poll-add-input";
    const go = document.createElement("button");
    go.className = "poll-ctlbtn"; go.textContent = "+ add";
    const submit = () => { if (input.value.trim()) { addOption(poll, input.value); input.value = ""; } };
    go.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    addRow.appendChild(input);
    addRow.appendChild(go);
    card.appendChild(addRow);
  }

  const foot = document.createElement("div");
  foot.className = "poll-you";
  if (poll.status === "closed" && result) {
    foot.textContent = summarizeWinners(poll, result);
  } else if (mine.length > 0) {
    foot.textContent = "you voted: " +
      mine.map((id) => poll.options.find((o) => o.id === id)?.text ?? id).join(poll.method === "ranked" ? " > " : ", ");
  } else if (opts.length > 0) {
    foot.textContent = poll.method === "ranked"
      ? "click options in your order of preference"
      : "click every option you'd be happy with";
  } else {
    foot.textContent = "no options yet — add the first one above";
  }
  card.appendChild(foot);

  if (poll.status === "closed" && result && result.method === "ranked" && result.rounds.length > 1) {
    const rd = document.createElement("div");
    rd.className = "poll-rounds";
    rd.textContent = result.rounds.map((r, k) => {
      const line = opts.map((o) => (r.counts[o.id] < 0 ? `${o.text}:✗` : `${o.text}:${r.counts[o.id] ?? 0}`)).join("  ");
      return `round ${k + 1}: ${line}${r.eliminated ? `  — out: ${poll.options.find((o) => o.id === r.eliminated)?.text ?? ""}` : ""}`;
    }).join("\n");
    card.appendChild(rd);
  }

  if (poll.status === "open") {
    const ctrls = document.createElement("div");
    ctrls.style.marginTop = "0.4rem";
    if (poll.method === "ranked" && mine.length > 0) {
      const clear = document.createElement("button");
      clear.className = "poll-ctlbtn"; clear.textContent = "clear ranking";
      clear.addEventListener("click", () => castVote(poll, []));
      ctrls.appendChild(clear);
    }
    if (poll.creator === myPeerId() && !poll.nominationsLocked && opts.length > 0) {
      const lk = document.createElement("button");
      lk.className = "poll-ctlbtn"; lk.textContent = "lock nominations";
      lk.addEventListener("click", () => lockNominations(poll));
      ctrls.appendChild(lk);
    }
    if (poll.creator === myPeerId()) {
      const cl = document.createElement("button");
      cl.className = "poll-ctlbtn poll-close"; cl.textContent = "close poll";
      cl.addEventListener("click", () => closePoll(poll));
      ctrls.appendChild(cl);
    }
    if (ctrls.childElementCount) card.appendChild(ctrls);
  }
  return card;
}

function renderPollCardInto(host: HTMLElement, pollId: string): void {
  const poll = pollStore.get(pollId);
  if (!poll) {
    const ph = document.createElement("span");
    ph.className = "poll-you"; ph.textContent = "🗳 poll unavailable";
    host.appendChild(ph);
    return;
  }
  const card = buildPollCard(poll);
  pollCards.set(pollId, card);
  host.appendChild(card);
}

function refreshPollCard(poll: Poll): void {
  if (!isUiActive()) return;
  const node = pollCards.get(poll.id);
  if (!node || !node.isConnected) return;
  // Preserve a half-typed "add an option" draft + focus across the re-render
  // that an inbound ballot/option would otherwise wipe out.
  const active = document.activeElement;
  const editing = active instanceof HTMLInputElement && node.contains(active) && active.classList.contains("poll-add-input");
  const draft = editing ? active.value : null;
  const fresh = buildPollCard(poll);
  node.replaceWith(fresh);
  pollCards.set(poll.id, fresh);
  if (draft !== null) {
    const inp = fresh.querySelector(".poll-add-input") as HTMLInputElement | null;
    if (inp) { inp.value = draft; inp.focus(); }
  }
}

function addPollCard(poll: Poll): void {
  const line: ChatLine = { from: poll.creator, text: poll.question, kind: "peer", pollId: poll.id };
  activeRoom.chatLog.push(line);
  trimChatLog(activeRoom);
  saveChat(activeRoom);
  if (isUiActive()) {
    renderChatLine(line);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    markUnread(activeRoom);
  }
}

function renderPolls(): void {
  if (!isUiActive()) return;
  pollCountEl.textContent = String(pollStore.size);
  pollListEl.innerHTML = "";
  for (const poll of [...pollStore.values()].sort((a, b) => b.createdAt - a.createdAt)) {
    const li = document.createElement("li");
    const nb = Object.keys(poll.ballots).length;
    li.textContent = `${poll.status === "open" ? "●" : "✓"} ${poll.question.slice(0, 24)} (${poll.options.length}◦ ${nb}✓)`;
    li.title = `${poll.method} · ${poll.options.map((o) => o.text).join(", ") || "no options yet"}`;
    li.style.cssText = "font-size:0.7rem;color:#aaa;padding:0.3rem 0;border-bottom:1px solid #1a1a1a;cursor:pointer;";
    li.addEventListener("click", () => { msgInput.value = `/poll vote ${poll.id} `; msgInput.focus(); });
    pollListEl.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Live calls: mic / camera over WebRTC media tracks
// ---------------------------------------------------------------------------

let localStream: MediaStream | null = null;
let inCall = false;
const callTiles = new Map<string, HTMLVideoElement>();   // "__local__" | peerId → video
let callBarEl: HTMLElement | null = null;
let callTilesEl: HTMLElement | null = null;
let callMuteBtn: HTMLButtonElement | null = null;
let callCamBtn: HTMLButtonElement | null = null;

function showCallBar(): void { if (callBarEl) callBarEl.hidden = false; }
function maybeHideCallBar(): void {
  if (callBarEl && !inCall && callTiles.size === 0) callBarEl.hidden = true;
}

function makeTile(key: string, label: string): HTMLVideoElement {
  const wrap = document.createElement("div");
  wrap.className = "call-tile";
  wrap.dataset.key = key;
  const v = document.createElement("video");
  v.autoplay = true; v.playsInline = true;
  const cap = document.createElement("span");
  cap.className = "call-name"; cap.textContent = label;
  wrap.appendChild(v); wrap.appendChild(cap);
  callTilesEl?.appendChild(wrap);
  callTiles.set(key, v);
  return v;
}

function removeTile(key: string): void {
  const v = callTiles.get(key);
  if (!v) return;
  v.srcObject = null;
  v.closest(".call-tile")?.remove();
  callTiles.delete(key);
}

function addRemoteStream(peerId: string, stream: MediaStream): void {
  let v = callTiles.get(peerId);
  if (!v) v = makeTile(peerId, peerLabel(peerId));
  if (v.srcObject !== stream) v.srcObject = stream;
  showCallBar();
}

async function startCall(): Promise<void> {
  if (!qpeer) { addMessage("", "connect to a room before starting a call", "system"); return; }
  if (inCall) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch {
    addMessage("", "⚠ could not access camera/microphone (permission denied?)", "system");
    return;
  }
  inCall = true;
  const local = makeTile("__local__", "you");
  local.muted = true;
  local.srcObject = localStream;
  showCallBar();
  qpeer.addLocalMedia(localStream);
  qpeer.broadcast({ kind: "call-start" });
  addMessage("", "📞 you started a call", "system");
  updateCallControls();
}

function endCall(): void {
  if (qpeer) { qpeer.removeLocalMedia(); qpeer.broadcast({ kind: "call-end" }); }
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  inCall = false;
  removeTile("__local__");
  updateCallControls();
  maybeHideCallBar();
}

function toggleCall(): void { if (inCall) endCall(); else void startCall(); }

function toggleMute(): void {
  const t = localStream?.getAudioTracks()[0];
  if (t) t.enabled = !t.enabled;
  updateCallControls();
}

function toggleCam(): void {
  const t = localStream?.getVideoTracks()[0];
  if (t) t.enabled = !t.enabled;
  updateCallControls();
}

function updateCallControls(): void {
  const audioOn = localStream?.getAudioTracks()[0]?.enabled ?? false;
  const videoOn = localStream?.getVideoTracks()[0]?.enabled ?? false;
  if (callMuteBtn) {
    callMuteBtn.textContent = audioOn ? "🎤" : "🔇";
    callMuteBtn.title = audioOn ? "Mute mic" : "Unmute mic";
  }
  if (callCamBtn) {
    callCamBtn.textContent = videoOn ? "🎥" : "🚫";
    callCamBtn.title = videoOn ? "Turn camera off" : "Turn camera on";
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  const roomId = getRoomId();
  roomIdEl.textContent = roomId;
  updateShareLink();

  // The URL-hash room is the first joined room and becomes the active one.
  const firstRoom = createRoom(roomId);
  rooms.set(roomId, firstRoom);
  setActiveRoom(firstRoom);
  uiActiveRoom = firstRoom;

  // Restore saved name
  myNameEl.value = myName;
  myNameEl.addEventListener("input", () => {
    myName = myNameEl.value.trim();
    localStorage.setItem("qos-name", myName);
    renderPeers();
    if (qpeer) signedBroadcast({ kind: "name", name: myName });
  });

  await loadZfa();
  await loadDyncap();
  loadLemmas();
  loadNotes();
  loadPolls();

  // Restore any rooms the user had joined in previous sessions (besides the
  // URL-hash one we already initialised). State for each is loaded from
  // per-room localStorage. The hash-room remains active.
  for (const otherRoomId of loadJoinedRooms()) {
    if (otherRoomId === roomId) continue;
    if (!validateCapability(otherRoomId)) continue;     // skip malformed
    const ctx = createRoom(otherRoomId);
    rooms.set(otherRoomId, ctx);
    loadRoomState(ctx);
  }
  saveJoinedRooms();
  // loadRoomState briefly switched aliases per room during restore; force the
  // UI back to the hash-room's view so the sidebar reflects the active room.
  setActiveRoom(firstRoom);
  renderTabs();
  renderPeers();
  renderLemmas();
  renderNotes();

  // The tab-add button prompts for a cap:room:… URL or token.
  tabAddBtn.addEventListener("click", () => promptJoinRoom());

  const cap = generateCapability("peer");
  myIdEl.textContent = cap;

  connectBtn.addEventListener("click", connect);
  sendBtn.addEventListener("click", send);
  msgInput.addEventListener("keydown", (e) => {
    if (cmdMenuOpen()) {
      if (e.key === "ArrowDown") { e.preventDefault(); moveCmdSel(1); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); moveCmdSel(-1); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptCmd(); return; }
      if (e.key === "Escape")    { e.preventDefault(); hideCmdMenu(); return; }
    }
    if (e.key === "Enter") send();
  });
  // Mobile keyboard fallback: when input gains focus, scroll it into view.
  // For browsers that honor `interactive-widget=resizes-content` (modern
  // Chrome/Firefox/Safari) this is a no-op; for the rest it ensures the
  // input doesn't end up underneath the soft keyboard.
  msgInput.addEventListener("focus", () => {
    // Defer to next tick so the keyboard has begun to open before we scroll.
    setTimeout(() => msgInput.scrollIntoView({ block: "end", behavior: "smooth" }), 200);
  });
  // Some browsers expose the visualViewport API. When the keyboard opens,
  // visualViewport's height shrinks; re-scroll the input to stay visible.
  if (typeof window !== "undefined" && window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      if (document.activeElement === msgInput) {
        msgInput.scrollIntoView({ block: "end" });
      }
    });
  }

  const qp = new URLSearchParams(window.location.search);
  const sig = qp.get("signal");
  if (sig) {
    signalUrlEl.value = sig;
    activeRoom.signalingUrl = sig;
  } else {
    signalUrlEl.value = activeRoom.signalingUrl;
  }
  signalUrlEl.addEventListener("change", () => {
    activeRoom.signalingUrl = signalUrlEl.value.trim() || DEFAULT_SIGNAL;
  });

  // Keep the sidebar visible on narrow screens until the user connects, so
  // the Connect button is reachable without finding the hamburger toggle.
  toggleSidebar(true);

  // Self-evident UI: quick-action toolbar + command palette.
  initUx();

  // Restore the saved transcript, or show the onboarding welcome on a fresh room.
  if (activeRoom.chatLog.length > 0) {
    for (const line of activeRoom.chatLog) renderChatLine(line);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    showWelcome();
  }
}

init();
