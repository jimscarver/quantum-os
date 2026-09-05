// lemma-parse.ts — pure parsing for the `/lemma` command and `@ref` tokens.
//
// No DOM, no storage, no app imports — like polls.ts / probe.ts, so it is
// node-runnable and unit-tested directly (test/lemma-parse.test.mjs).
//
// A lemma used to be named by its whole claim, so a multi-word claim needed
// `[brackets]` to declare and `@[brackets]` to cite (issue #128). The grammar
// here keeps every old form working and adds two shorter ones:
//
//   /lemma All men are @mortal            → name "mortal", text "All men are mortal"
//   /lemma @mortality All men are mortal   → name "mortality", text "All men are mortal"
//   /lemma socrates is a man               → name "socrates is a man" (bare multi-word)
//   /lemma mortality ^v                    → name "mortality", twists "^v"  (legacy)
//   /lemma [all men are mortal] ^v         → bracket form                    (legacy)
//   /lemma concl | @mortal @socrates       → name "concl", twists composed
//
// So you write the claim as a sentence, mark one word with `@` as the handle,
// and cite it as `@mortal` everywhere — no brackets.

// A lemma name may contain spaces ("all men are mortal"). It is referenced as
// @[name with spaces] (bare @name still works for single-word names) and stored
// under a canonical key: trimmed, with inner whitespace collapsed to one space.
// canonLemma is idempotent and a no-op for single-word names, so applying it at
// every store boundary is safe and leaves existing lemmas unchanged.
export function canonLemma(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export type RefTok = { kind: "ref"; name: string } | { kind: "lit"; text: string };

// Tokenize a command arg into lemma references (@word or @[multi word]) and
// literal twist tokens, preserving order. Multi-word refs survive the
// whitespace split that bare tokenization would otherwise break.
export function parseRefTokens(arg: string): RefTok[] {
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

// Split a `<name> <rest>` argument into [canonicalName, rest], honoring a
// leading [bracketed name] so a multi-word name doesn't eat the rest. Used by
// `/pass <name> <peer>` (name + peer, not name + twists — different from
// parseLemmaDecl).
export function splitLemmaNameArg(arg: string): [string, string] {
  const t = arg.trim();
  const br = t.match(/^\[([^\]]*)\]\s*([\s\S]*)$/);
  if (br) return [canonLemma(br[1]), br[2].trim()];
  const sp = t.search(/\s/);
  if (sp === -1) return [canonLemma(t), ""];
  return [canonLemma(t.slice(0, sp)), t.slice(sp + 1).trim()];
}

export type LemmaDecl = { name: string; twistsArg: string; text?: string };
export type LemmaDeclResult = LemmaDecl | { error: string };

// An @handle is an identifier: it has to be typeable bare as `@handle` in any
// later command, so no spaces, brackets, colons or pipes.
const HANDLE_RE = /^[A-Za-z0-9][\w-]*$/;
// Trailing sentence punctuation on the marked word ("...are @mortal.") is not
// part of the handle.
const TRAIL_PUNCT = /[.,;:!?]+$/;

// Does `s` look like it was meant as a twist argument (symbolic ^v<>/\+-, hex
// 0-7, a cap:token, or @refs) rather than more words of a name? Used only to
// decide whether `/lemma <word> <rest>` is the legacy name+twists form; the
// real validation and error reporting stay in the command handler.
export function looksLikeTwistArg(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (t.startsWith("@") || t.startsWith("cap:")) return true;
  return /^[\^v<>/\\+\-0-7\s]+$/.test(t);
}

// Parse a `/lemma` argument into { name, twistsArg, text? } or { error }.
// `twistsArg` is handed on verbatim to the handler's existing resolver
// (symbolic / hex / cap:token / @refs); "" means auto-allocate.
export function parseLemmaDecl(arg: string): LemmaDeclResult {
  const whole = arg.trim();
  if (!whole) return { error: "usage: /lemma <statement> [| <twists>]" };

  // An explicit pipe splits statement from twists: /lemma <statement> | <twists>.
  // `|` is not a twist symbol or a legal name character, so this is unambiguous.
  let statement = whole;
  let twistsArg = "";
  const pipe = whole.indexOf("|");
  if (pipe !== -1) {
    statement = whole.slice(0, pipe).trim();
    twistsArg = whole.slice(pipe + 1).trim();
  }
  if (!statement) return { error: "lemma name is empty" };

  // 1. Bracket form: [multi word name]  (+ trailing twists when there is no pipe).
  const br = statement.match(/^\[([^\]]*)\]\s*([\s\S]*)$/);
  if (br) {
    if (pipe === -1 && br[2].trim()) twistsArg = br[2].trim();
    return finish(canonLemma(br[1]), twistsArg);
  }

  // 2. Legacy `<name> <twists>` — a single leading token then something that
  // reads as a twist argument (symbolic / hex / cap:token / @refs). Checked
  // before the @handle rule so `/lemma concl @a @b` still composes from refs.
  // A leading `@` on the name token is just dropped (`/lemma @concl @a @b`).
  if (pipe === -1) {
    const sp = statement.match(/^(\S+)\s+(\S[\s\S]*)$/);
    if (sp && looksLikeTwistArg(sp[2])) {
      return finish(canonLemma(sp[1].replace(/^@/, "")), sp[2].trim());
    }
  }

  // 3. An @handle marked in the statement.
  const ats = [...statement.matchAll(/(?:^|\s)@(\S+)/g)];
  if (ats.length > 1) {
    return { error: "mark exactly one word with @ as the handle, or use [name] for a multi-word name" };
  }
  if (ats.length === 1) {
    const handle = ats[0][1].replace(TRAIL_PUNCT, "");
    if (!HANDLE_RE.test(handle)) {
      return { error: `invalid @handle '${handle}'  (letters, digits, - and _ only)` };
    }
    // A leading "@handle " with more words after it is a handle that is NOT part
    // of the sentence — drop it from the text. Otherwise the @ just marks a word
    // that stays in the text ("All men are @mortal" → text "All men are mortal").
    const lead = statement.match(/^@(\S+)\s+(\S[\s\S]*)$/);
    const text = lead && lead[1].replace(TRAIL_PUNCT, "") === handle
      ? canonLemma(lead[2])
      : canonLemma(statement.replace(/(^|\s)@(\S+)/, (_m, pre, w) => pre + w));
    return finish(handle, twistsArg, text === handle ? undefined : text);
  }

  // 4. No @handle, not a legacy split — the whole statement is the name. This is
  // how a bare multi-word name ("socrates is a man") now works.
  return finish(canonLemma(statement), twistsArg);

  function finish(name: string, tw: string, text?: string): LemmaDeclResult {
    if (!name) return { error: "lemma name is empty" };
    if (/[[\]:|]/.test(name)) {
      return { error: `invalid lemma name '${name}'  (no brackets, colons or pipes; spaces are fine)` };
    }
    return text ? { name, twistsArg: tw, text } : { name, twistsArg: tw };
  }
}
