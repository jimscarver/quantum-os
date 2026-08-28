# Libraries of audio and video

How a room builds a library of recordings — **with no chain anywhere in it**.
A chain can be synced to later, and the last section says what that would add;
everything before it works with peers, browsers and the room memory daemon.

Tracking issue: [#99](https://github.com/rchain-community/quantum-os/issues/99).

---

## The question the design answers

A group records things — a call, a reading, a piece of music — and wants to
find them again, play them, and hand them to whoever joins next. Today an
attachment is pushed to whoever happens to be present and lives in the
transcript, so the answer to "where is that recording from Tuesday" is
"scroll, and hope somebody still has the tab open".

A library is four separate facts, and they fail separately:

| | |
|---|---|
| **What exists** | the entries: name, size, kind, who added it, when |
| **Which bytes** | the content hash, so a copy from anyone is the copy the entry means |
| **Who has them** | availability, which changes as people come and go |
| **Who may have them** | a capability, the same kind the room already mints |

Keeping them separate is the whole design. An entry can exist while nobody is
holding the bytes, and a library that says so is useful; one that pretends
otherwise is a list of broken links.

---

## Layer 0 — where bytes actually live

Three places, all of which exist today:

- **A browser's OPFS.** Origin-private storage, no permission prompt, survives
  reload, and the recorder already streams into it (`record.ts`). This is where
  a peer keeps what it holds.
- **The user's own filesystem**, through a directory handle
  (`showDirectoryPicker`, Chromium) or a file input elsewhere. Read lazily, so a
  20 GB folder costs nothing until something is fetched from it.
- **The room memory daemon** (`scripts/qos-cli/room-memory.mjs`), which is a
  peer with a disk and no browser quota. It already holds the durable half of a
  room and re-serves it to joiners. **This is what makes a library survive
  everybody closing their laptops — not a chain.**

No layer above cares which of the three a peer is using.

## Layer 1 — a name that is the content

Every entry is identified by `SHA-256` of the bytes. The browser already has it
(`crypto.subtle.digest`, as `dyncap.ts` uses), and it gives, for free:

- **integrity** — a fetch from any peer is verifiable against the name it was
  fetched by;
- **deduplication** — the same recording added twice is one entry;
- **resumability** — a partial fetch can be continued from a different holder,
  because the name does not depend on who is sending.

## Layer 2 — the index, which is ordinary room state

An entry is `{hash, name, mime, size, addedBy, at, cap?}`. The index is a
per-room store, and it is the same shape as every other store in this app:

- dyncap-signed `library-entry` envelopes, so who added an entry is not a guess;
- replayed to joiners in the existing `sync-*` handshake;
- removable through the existing tombstone machinery (`retract`, kind
  `"library"`), so a removal does not heal back on the next sync;
- persisted per room in `localStorage`, and by the daemon on disk.

Nothing here is new machinery. It is the lemma store with different fields, and
it should be built by copying that shape rather than inventing beside it.

## Layer 3 — who is holding it, right now

Separate from the index, and deliberately not persisted the same way: a peer
announces which hashes it currently has, and withdraws when it drops them. The
UI then distinguishes three states that matter to a person:

- **here** — a holder is in the room; play or fetch it now
- **known** — the entry exists, no holder is present; ask, or wait
- **gone** — no holder has been seen for a long time, and someone should be told
  before the entry is trusted as a library

The daemon holding a copy is what turns most *known* into *here*.

## Layer 4 — fetch, rather than broadcast

`attachments.ts` already does the hard parts: chunking, pacing against
`bufferedAmount`, reassembly, and rendering the result. What is wrong for a
library is only the shape of the request — a push to everyone, at 8 MB, because
the payload is base64 inside a broadcast JSON envelope.

The change is to ask one holder for one hash and be answered directly:
progress, cancellation, and a size limit set by measurement rather than by
nerve. Resumable per chunk, because the hash names the whole file independently
of who sends it.

## Layer 5 — the interface

A library block in the sidebar: what the room has, by entry rather than by
message; filterable; showing availability from layer 3. Play as chunks arrive
rather than after assembly. Drop a file on it to add it, the way dropping one
into the chat sends it.

## Layer 6 — a chain, later and optionally

Everything above works with no chain, and most rooms will never want one. What
a chain adds, when a group does:

- an index that survives losing **every** peer *and* the daemon;
- a name for the library that outlives the room, and can be handed to someone
  who was never in it;
- a capability that a group holds and enforces on chain, once a group can act
  as an identity ([#103](https://github.com/rchain-community/quantum-os/issues/103)).

What it does not add is storage. Rholang holds terms, not media: the bytes stay
in layers 0–4 whatever happens on chain, and what a chain can hold is the index
— hashes, names, capabilities. This is a **sync of layer 2**, not a foundation
under it, and it is designed in
[#102](https://github.com/rchain-community/quantum-os/issues/102).

---

## Components, and the macros that compose them

None of the layers above is a "library feature". Each is a **small verb**, and
the library is what a room composes out of them — which is the point of having
a macro language at all. A group that wants a different workflow writes a
different `+command` rather than waiting for one to be built.

**The verbs.** One job each, usable from the box, from `/script`, and from
inside a macro body:

| verb | layer | what it does |
|---|---|---|
| `/file add <file>` | 1–2 | hash it, make an entry, announce holding it |
| `/file list [--here \| --mine \| <peer>]` | 2–3 | the index, filtered by availability |
| `/file holders <hash>` | 3 | who has these bytes right now |
| `/file get <hash\|name>` | 4 | fetch from a holder, with progress |
| `/file drop <hash>` | 3 | stop holding it (the entry stays) |
| `/file pin <hash>` | 0 | ask the daemon to hold a copy — durability, no chain |
| `/file cap <hash> [label]` | 2 | mint the capability that says who may read it |
| `/file forget <hash>` | 2 | retract the entry (existing tombstone machinery) |

Each answers in lines, so each composes. `/file add` broadcasts its entry
because that is the point of it; `/file get` does not, because a fetch is
between two peers.

**The macros.** A workflow is a `+command`, which is dyncap-signed room state,
replayed to joiners and owned by its author — so a group adopts a way of
working the way EIES groups adopted commands, without a release.

```
/macro define $shelve($name) // add the file at hand and name it for the room
/file add $name
/file pin $name
/lemma library-$name

/macro define $showreel() // what can be played right now
/file list --here
```

Then `+shelve interview-tuesday` is a group's own verb. The same body could
name a capability, post to a group inbox, or open a poll on what to keep —
none of which needs anything built.

**On chain, later, the same shape.** The `%` macro library is where a chain-side
component would live (`%directory`, `%issuer` and `%multisig` already exist),
so a library's index write is a `%` macro expanded and signed in the browser —
not a new subsystem, and not a prerequisite for any of layers 0–5.

**What this asks of the build.** Verbs first, and no verb that only exists to
serve one screen: if the interface (layer 5) needs something the verbs cannot
say, the verb is missing, not the screen. That is what keeps the library
composable rather than a feature with a UI.

---

## Build order

1. **Layer 1 + 2** — hash a file, make an entry, gossip the index, show it.
   Nothing is transferred yet; the library is a list, and already useful.
2. **Layer 3** — availability, so the list says what can be had.
3. **Layer 4** — fetch on request, past 8 MB, with progress
   ([#100](https://github.com/rchain-community/quantum-os/issues/100)).
4. **Layer 0's durable half** — the daemon holds copies, so the library outlives
   the browsers.
5. **Layer 5** — the interface
   ([#101](https://github.com/rchain-community/quantum-os/issues/101)).
6. **Layer 6** — chain sync, if a group wants it
   ([#102](https://github.com/rchain-community/quantum-os/issues/102)).

Each step is usable on its own, and none of the first five needs an rnode, a
key or phlo.
