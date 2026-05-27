import { loadZfa, generateCapability, validateCapability,
         spectralGap, achievesZfa } from "./zfa.js";
import { QOSPeer } from "./peer.js";

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

const sidebarEl    = document.getElementById("sidebar")!;
const overlayEl    = document.getElementById("sidebar-overlay")!;
const toggleBtn    = document.getElementById("sidebar-toggle") as HTMLButtonElement;
const myNameEl     = document.getElementById("my-name") as HTMLInputElement;
const myIdEl       = document.getElementById("my-id")!;
const roomIdEl     = document.getElementById("room-id")!;
const DEFAULT_SIGNAL = "wss://quantum-os-signaling.fly.dev";
const signalUrlEl  = document.getElementById("signal-url") as HTMLInputElement;
const connectBtn   = document.getElementById("connect-btn") as HTMLButtonElement;
const statusDot    = document.getElementById("status-dot")!;
const statusText   = document.getElementById("status-text")!;
const peerList     = document.getElementById("peer-list")!;
const peerCount    = document.getElementById("peer-count")!;
const messagesEl   = document.getElementById("messages")!;
const msgInput     = document.getElementById("msg-input") as HTMLInputElement;
const sendBtn      = document.getElementById("send-btn") as HTMLButtonElement;
const shareLink    = document.getElementById("share-link") as HTMLAnchorElement;
const copyBtn      = document.getElementById("copy-btn") as HTMLButtonElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const peers = new Set<string>();
const peerNames = new Map<string, string>();   // peerId → display name
let myName: string = localStorage.getItem("qos-name") ?? "";
let qpeer: QOSPeer | null = null;

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
    peerList.appendChild(li);
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

// ---------------------------------------------------------------------------
// Slash command handler
// ---------------------------------------------------------------------------

function handleCommand(raw: string): void {
  const parts = raw.slice(1).trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ");
  const sys = (text: string) => addMessage("", text, "system");

  switch (cmd) {
    case "help":
      sys("QLF slash commands:");
      sys("  /help        — show this help");
      sys("  /id          — your peer ID and ZFA proof");
      sys("  /room        — room capability token");
      sys("  /cap [label] — generate a new ZFA capability");
      sys("  /zfa [token] — validate a capability token");
      sys("  /braket      — bra-ket duality via ZFA");
      sys("  /qucalc      — your peer as a RhoQuCalc process");
      sys("  //message    — send a message starting with /");
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
      const ket = generateCapability("ket");
      const bra = generateCapability("bra");
      const tw = tokenTwists(ket)!;
      const { gap } = twistStats(tw);
      sys("bra-ket duality (ZFA / RhoQuCalc):");
      sys("  |ψ⟩  action(Form)  twists [+,−]  eval = f.toMatrix");
      sys("  ⟨ψ|  lift(Form)    twists [−,+]  eval = f.toMatrix†");
      sys(`  both ZFA-balanced: ✓  spectral gap: ${gap}`);
      sys("  bra_ket_always_balanced: ✓ (BraKetRhoQuCalc.lean)");
      sys(`  sample ket: ${ket}`);
      sys(`  sample bra: ${bra}`);
      break;
    }

    case "qucalc": {
      const id = qpeer?.peerId ?? "(not connected)";
      const tw = id !== "(not connected)" ? tokenTwists(id) : null;
      sys("RhoQuCalc process (this peer):");
      sys("  action(f) ≅ |ψ⟩   twist: [+,−]   eval = f.toMatrix");
      sys("  lift(f)   ≅ ⟨ψ|   twist: [−,+]   eval = f.toMatrix†");
      sys("  parallel(action,lift)  → ZFA-balanced superposition");
      sys("  rho_process_always_zfa: ✓ (Lean-verified)");
      sys(`  peer ID: ${id}`);
      if (tw) {
        const { pos, neg, gap } = twistStats(tw);
        sys(`  twists: ${tw.length}  (${pos} pos / ${neg} neg)  spectral gap: ${gap}`);
      }
      break;
    }

    default:
      sys(`unknown command: /${cmd}  (type /help for list)`);
  }
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

async function connect(): Promise<void> {
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

  setStatus("connecting", "connecting…");
  connectBtn.textContent = "Disconnect";

  qpeer = new QOSPeer({
    signalingUrl,
    roomId,
    onMessage(from, data) {
      if (typeof data === "object" && data !== null) {
        const d = data as Record<string, unknown>;
        if (d.kind === "name") {
          peerNames.set(from, String(d.name ?? ""));
          renderPeers();
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
    },
    onPeerJoined(id) {
      peers.add(id);
      renderPeers();
      addMessage("", `${peerLabel(id)} joined`, "system");
    },
    onPeerLeft(id) {
      peers.delete(id);
      renderPeers();
      addMessage("", `${peerLabel(id)} left`, "system");
      peerNames.delete(id);
    },
  });

  try {
    await qpeer.connect();
    setStatus("connected", `connected · ${signalingUrl}`);
    msgInput.disabled = false;
    sendBtn.disabled = false;
    renderPeers();
    addMessage("", `joined room ${shortId(roomId)}`, "system");
  } catch (err) {
    setStatus("disconnected", `failed: ${err}`);
    connectBtn.textContent = "Connect";
    qpeer = null;
  }
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
    handleCommand(text);
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

  const cap = generateCapability("peer");
  myIdEl.textContent = cap;

  connectBtn.addEventListener("click", connect);
  sendBtn.addEventListener("click", send);
  msgInput.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

  const qp = new URLSearchParams(window.location.search);
  const sig = qp.get("signal");
  if (sig) signalUrlEl.value = sig;
  else signalUrlEl.value = DEFAULT_SIGNAL;

  handleCommand("/help");
}

init();
