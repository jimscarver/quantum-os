// library.ts — the index of what a room holds.
//
// Layers 1 and 2 of `Media_Libraries.md`: a file's name is its content hash,
// and the index of those names is ordinary room state. No transfer here and no
// chain anywhere — an index is useful before either exists, because knowing
// what a room has is a different question from being able to fetch it.
//
// No DOM and no app imports (the shape `polls.ts` and `gov.ts` keep). Two
// browser built-ins are used: `crypto.subtle`, the same digest `dyncap.ts`
// derives identity with, and OPFS at the foot of the file — the library's own
// byte store, kept here rather than in app.ts because holding a file and
// indexing it are one concern.

/** One thing the room has, or had. */
export interface LibraryEntry {
  /** SHA-256 of the bytes, hex. The entry's identity: two adds of one file are one entry. */
  hash: string;
  name: string;
  mime: string;
  size: number;
  /** peerId of whoever added it, and their label at the time. */
  addedBy: string;
  addedLabel: string;
  at: number;
  /** A capability naming who may read it, when one has been minted. */
  cap?: string;
}

export const HASH_RE = /^[0-9a-f]{64}$/;
/** Long enough to be unambiguous in a room, short enough to type. */
export const SHORT_HASH = 12;

/** SHA-256 of a file's bytes, hex — the only name an entry has. */
export async function hashBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const shortHash = (hash: string): string => hash.slice(0, SHORT_HASH);

/**
 * An entry from the wire, or null.
 *
 * Everything is checked because everything arrives from a peer: a hash that is
 * not a hash, a negative size, a name long enough to be an attack on the
 * sidebar. The hash is not verified against bytes here — that happens when the
 * bytes arrive, which is the only place it can.
 */
export function entryFromWire(raw: unknown): LibraryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const hash = String(r.hash ?? "").toLowerCase();
  if (!HASH_RE.test(hash)) return null;
  const size = Number(r.size);
  if (!Number.isFinite(size) || size < 0 || size > Number.MAX_SAFE_INTEGER) return null;
  const name = String(r.name ?? "").trim().slice(0, 200);
  if (!name) return null;
  const at = Number(r.at);
  const cap = typeof r.cap === "string" && r.cap.startsWith("cap:") ? r.cap : undefined;
  return {
    hash,
    name,
    mime: String(r.mime ?? "application/octet-stream").slice(0, 100),
    size,
    addedBy: String(r.addedBy ?? ""),
    addedLabel: String(r.addedLabel ?? "?").slice(0, 60),
    at: Number.isFinite(at) && at > 0 ? at : Date.now(),
    ...(cap ? { cap } : {}),
  };
}

/**
 * Newest first, and stable: two entries added in the same millisecond (a
 * multi-file add) order by hash rather than by whichever the map yielded first,
 * so every peer lists them the same way.
 */
export function sortEntries(entries: Iterable<LibraryEntry>): LibraryEntry[] {
  return [...entries].sort((a, b) => (b.at - a.at) || a.hash.localeCompare(b.hash));
}

/**
 * The entry someone meant.
 *
 * A hash, a hash prefix, or a name — because nobody types 64 hex digits, and
 * the name is what a person remembers. An ambiguous prefix or a name held by
 * two entries returns null rather than guessing: picking one of two files
 * silently is worse than asking again.
 */
export function findEntry(entries: Iterable<LibraryEntry>, needle: string): LibraryEntry | null {
  const want = needle.trim().toLowerCase();
  if (!want) return null;
  const all = [...entries];
  const exact = all.find((e) => e.hash === want);
  if (exact) return exact;
  const byPrefix = all.filter((e) => e.hash.startsWith(want));
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) return null;
  const byName = all.filter((e) => e.name.toLowerCase() === want);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return null;
  const partial = all.filter((e) => e.name.toLowerCase().includes(want));
  return partial.length === 1 ? partial[0] : null;
}

/**
 * Whether the bytes can actually be had.
 *
 * Kept apart from the index because it fails apart from it: an entry is a
 * durable fact and a holder is a live one. A library that says "known" when
 * nobody is holding something is telling the truth; one that lists it exactly
 * like a file you can play is a list of broken links.
 */
export type Availability = "held" | "here" | "known" | "gone";

/** How long without a holder before an entry stops being merely offline. */
export const GONE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function availabilityOf(
  hash: string, held: boolean, holdersPresent: number, lastSeen: number | undefined, now = Date.now(),
): Availability {
  if (held) return "held";
  if (holdersPresent > 0) return "here";
  if (lastSeen === undefined || now - lastSeen > GONE_AFTER_MS) return "gone";
  return "known";
}

/** What kind of thing it is, for an interface that treats media differently. */
export function kindOf(mime: string): "image" | "audio" | "video" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** The mark that says whether an entry can be had, and from whom. */
export const AVAILABILITY_MARK: Record<Availability, string> = {
  held: "●",     // the bytes are here
  here: "◉",     // a peer in the room has them
  known: "○",    // the entry exists; no holder is present
  gone: "⚠",     // no holder seen in a long time — the entry may be all that is left
};

/** One line per entry, for the transcript. */
export function describeEntry(e: LibraryEntry, avail: Availability, holders = 0): string {
  const icon = { image: "🖼", audio: "🎵", video: "🎬", file: "📄" }[kindOf(e.mime)];
  const from = avail === "here" ? `  · ${holders} holder${holders === 1 ? "" : "s"} here` : "";
  return `${AVAILABILITY_MARK[avail]} ${icon} ${e.name}   ${fmtSize(e.size)}  ${shortHash(e.hash)}`
    + `  · added by ${e.addedLabel}${from}${e.cap ? "  · " + e.cap.split(":")[1] : ""}`;
}

// ---------------------------------------------------------------------------
// The bytes
//
// OPFS — origin-private, no permission prompt, survives a reload, and already
// where `record.ts` streams a recording. Holding a file means having its bytes
// here; an entry in the index without them is a name for something somebody
// else has.
//
// Every operation answers rather than throws: storage can be unavailable (a
// private window, a browser that blocks site data), and a library that cannot
// keep bytes should still index and list.
// ---------------------------------------------------------------------------

type Writable = { write(d: Blob): Promise<void>; close(): Promise<void> };
type FileHandle = { createWritable(): Promise<Writable>; getFile(): Promise<File> };
type Dir = {
  getFileHandle(n: string, o?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(n: string): Promise<void>;
  keys(): AsyncIterableIterator<string>;
};

const BYTES_DIR = "library";

async function bytesDir(create = false): Promise<Dir | null> {
  const storage = (navigator as unknown as { storage?: { getDirectory?(): Promise<Dir> } }).storage;
  if (!storage?.getDirectory) return null;
  try {
    const root = await storage.getDirectory() as unknown as {
      getDirectoryHandle(n: string, o?: { create?: boolean }): Promise<Dir>;
    };
    return await root.getDirectoryHandle(BYTES_DIR, { create });
  } catch { return null; }
}

/** Keep a file's bytes under its hash. False when storage would not take them. */
export async function putBytes(hash: string, blob: Blob): Promise<boolean> {
  const dir = await bytesDir(true);
  if (!dir) return false;
  try {
    const handle = await dir.getFileHandle(hash, { create: true });
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return true;
  } catch { return false; }
}

/** The bytes we hold for a hash, or null. */
export async function getBytes(hash: string): Promise<File | null> {
  const dir = await bytesDir();
  if (!dir) return null;
  try { return await (await dir.getFileHandle(hash)).getFile(); }
  catch { return null; }
}

export async function dropBytes(hash: string): Promise<void> {
  const dir = await bytesDir();
  try { await dir?.removeEntry(hash); } catch { /* already gone */ }
}

// A fetch arrives in pieces over minutes, so it is written as it comes rather
// than assembled in memory: a partial file has a `.part` suffix, which
// `heldHashes` refuses to count, so an interrupted fetch can never be mistaken
// for a file we hold.
const PART = ".part";

export interface PartWriter {
  write(chunk: BlobPart): Promise<void>;
  close(): Promise<File | null>;
  abort(): Promise<void>;
}

/** Somewhere to put a fetch while it arrives. Null when storage refuses. */
export async function openPart(hash: string): Promise<PartWriter | null> {
  const dir = await bytesDir(true);
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(hash + PART, { create: true });
    const w = await handle.createWritable();
    return {
      async write(chunk) { await w.write(new Blob([chunk])); },
      async close() {
        await w.close();
        try { return await handle.getFile(); } catch { return null; }
      },
      async abort() {
        try { await w.close(); } catch { /* already gone */ }
        try { await dir.removeEntry(hash + PART); } catch { /* already gone */ }
      },
    };
  } catch { return null; }
}

export async function dropPart(hash: string): Promise<void> {
  const dir = await bytesDir();
  try { await dir?.removeEntry(hash + PART); } catch { /* already gone */ }
}

/** What is actually on disk — the truth behind what we claim to hold. */
export async function heldHashes(): Promise<string[]> {
  const dir = await bytesDir();
  if (!dir) return [];
  const out: string[] = [];
  try { for await (const name of dir.keys()) if (HASH_RE.test(name)) out.push(name); }
  catch { /* nothing to list */ }
  return out;
}
