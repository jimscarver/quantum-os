/// RhoQu — macro layer over quantum-os /commands.
///
/// Commit 1 of the spec: a hand-rolled recursive-descent parser + transpiler
/// that turns RhoQu source into a flat array of `/command` strings to be
/// executed sequentially by the dispatcher.
///
/// Supported in this commit:
///   process Name(arg1, arg2) { body }      — definitions
///   new x y z;                              — expands to /grant x, /grant y, /grant z
///   parallel { stmt1; stmt2; … }            — sequential expansion (true parallel = separate peers)
///   Name(val1, val2);                       — call a defined process; $arg substitution in body
///   /cmd ...;                                — raw command, $arg substitution applied
///   // comment up to next ; or newline       — skipped
///
/// Deferred to future commits:
///   if expr { ... } else { ... }
///   on channel(x) { ... }
///   timeout Ns { ... }
///   send / receive primitives ('!', '?', '->')
///
/// The transpiler is pure: source string → string[]. The dispatcher runs
/// each command via handleCommand; errors in one don't stop subsequent.

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type TokenKind =
  | "process" | "new" | "in" | "parallel"
  | "ident" | "number" | "string" | "command"
  | "lbrace" | "rbrace" | "lparen" | "rparen"
  | "semi" | "comma" | "eof";

interface Token { kind: TokenKind; value: string; line: number; col: number }

class RhoQuError extends Error {
  constructor(msg: string, public line: number, public col: number) {
    super(`RhoQu: ${msg} (line ${line}, col ${col})`);
  }
}

const KEYWORDS = new Set(["process", "new", "in", "parallel"]);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0, line = 1, col = 1;
  const push = (kind: TokenKind, value: string, l: number, c: number) =>
    tokens.push({ kind, value, line: l, col: c });
  const advance = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src[i + k] === "\n") { line++; col = 1; } else { col++; }
    }
    i += n;
  };

  while (i < src.length) {
    const ch = src[i];

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") { advance(1); continue; }

    // Line comment (// …) — skip to end of line, do NOT emit a semi
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") advance(1);
      continue;
    }

    // Raw command starting with `/` and not `//` — read until terminating `;`
    // (or end-of-input). The whole text (without the trailing `;`) is captured
    // verbatim and dispatched as a /command, with $arg substitution applied
    // at interpret time.
    if (ch === "/") {
      const startL = line, startC = col;
      let buf = "";
      while (i < src.length && src[i] !== ";") {
        buf += src[i]; advance(1);
      }
      push("command", buf.trim(), startL, startC);
      // Don't consume the ; here; let the parser see it.
      continue;
    }

    // String literal (single or double quote) — captured with surrounding
    // quotes intact so raw commands can pass them through to the dispatcher.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startL = line, startC = col;
      let buf = quote;
      advance(1);
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) { buf += src[i] + src[i + 1]; advance(2); }
        else { buf += src[i]; advance(1); }
      }
      if (i >= src.length) throw new RhoQuError("unterminated string literal", startL, startC);
      buf += quote; advance(1);
      push("string", buf, startL, startC);
      continue;
    }

    // Number
    if (ch >= "0" && ch <= "9") {
      const startL = line, startC = col;
      let buf = "";
      while (i < src.length && /[0-9.]/.test(src[i])) { buf += src[i]; advance(1); }
      push("number", buf, startL, startC);
      continue;
    }

    // Identifier or keyword. Allow letters, digits, _, -, @, .
    if (/[A-Za-z_@]/.test(ch)) {
      const startL = line, startC = col;
      let buf = "";
      while (i < src.length && /[A-Za-z0-9_\-@.]/.test(src[i])) { buf += src[i]; advance(1); }
      const kind: TokenKind = KEYWORDS.has(buf) ? (buf as TokenKind) : "ident";
      push(kind, buf, startL, startC);
      continue;
    }

    // Punctuation
    if (ch === "{") { push("lbrace", "{", line, col); advance(1); continue; }
    if (ch === "}") { push("rbrace", "}", line, col); advance(1); continue; }
    if (ch === "(") { push("lparen", "(", line, col); advance(1); continue; }
    if (ch === ")") { push("rparen", ")", line, col); advance(1); continue; }
    if (ch === ";") { push("semi", ";", line, col); advance(1); continue; }
    if (ch === ",") { push("comma", ",", line, col); advance(1); continue; }

    throw new RhoQuError(`unexpected character '${ch}'`, line, col);
  }

  push("eof", "", line, col);
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type Stmt =
  | { kind: "new"; names: string[] }
  | { kind: "parallel"; body: Stmt[] }
  | { kind: "call"; name: string; args: string[] }
  | { kind: "cmd"; text: string };

interface ProcessDef { name: string; params: string[]; body: Stmt[] }

interface Program { defs: Map<string, ProcessDef>; top: Stmt[] }

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private i = 0;
  constructor(private toks: Token[]) {}

  private peek(off = 0): Token { return this.toks[this.i + off]; }
  private eat(): Token { return this.toks[this.i++]; }
  private expect(kind: TokenKind): Token {
    const t = this.peek();
    if (t.kind !== kind) throw new RhoQuError(`expected ${kind}, got ${t.kind} '${t.value}'`, t.line, t.col);
    return this.eat();
  }
  private maybe(kind: TokenKind): Token | null {
    return this.peek().kind === kind ? this.eat() : null;
  }

  parseProgram(): Program {
    const defs = new Map<string, ProcessDef>();
    const top: Stmt[] = [];
    while (this.peek().kind !== "eof") {
      if (this.peek().kind === "process") {
        const def = this.parseProcessDef();
        defs.set(def.name, def);
      } else {
        const s = this.parseStmt();
        if (s) top.push(s);
        // Statements are terminated by `;`; tolerate trailing/extra `;`.
        while (this.maybe("semi")) { /* consume extras */ }
      }
    }
    return { defs, top };
  }

  private parseProcessDef(): ProcessDef {
    this.expect("process");
    const name = this.expect("ident").value;
    this.expect("lparen");
    const params: string[] = [];
    if (this.peek().kind !== "rparen") {
      params.push(this.expect("ident").value);
      while (this.maybe("comma")) params.push(this.expect("ident").value);
    }
    this.expect("rparen");
    this.expect("lbrace");
    const body = this.parseStmtsUntil("rbrace");
    this.expect("rbrace");
    return { name, params, body };
  }

  private parseStmtsUntil(closer: TokenKind): Stmt[] {
    const out: Stmt[] = [];
    while (this.peek().kind !== closer && this.peek().kind !== "eof") {
      const s = this.parseStmt();
      if (s) out.push(s);
      while (this.maybe("semi")) { /* consume extras */ }
    }
    return out;
  }

  private parseStmt(): Stmt | null {
    const t = this.peek();
    if (t.kind === "new") return this.parseNew();
    if (t.kind === "parallel") return this.parseParallel();
    if (t.kind === "command") return this.parseCmd();
    if (t.kind === "ident") return this.parseCall();
    if (t.kind === "semi") { this.eat(); return null; }
    throw new RhoQuError(`unexpected token '${t.value}' (kind: ${t.kind})`, t.line, t.col);
  }

  private parseNew(): Stmt {
    this.expect("new");
    const names: string[] = [];
    while (this.peek().kind === "ident") names.push(this.eat().value);
    if (names.length === 0) {
      const t = this.peek();
      throw new RhoQuError("`new` requires at least one identifier", t.line, t.col);
    }
    // Optional `in` keyword for readability (parser doesn't actually use it
    // since `new x y z;` already binds in the enclosing scope).
    this.maybe("in");
    this.expect("semi");
    return { kind: "new", names };
  }

  private parseParallel(): Stmt {
    this.expect("parallel");
    this.expect("lbrace");
    const body = this.parseStmtsUntil("rbrace");
    this.expect("rbrace");
    this.maybe("semi");
    return { kind: "parallel", body };
  }

  private parseCmd(): Stmt {
    const t = this.expect("command");
    this.expect("semi");
    return { kind: "cmd", text: t.value };
  }

  private parseCall(): Stmt {
    const name = this.expect("ident").value;
    this.expect("lparen");
    const args: string[] = [];
    if (this.peek().kind !== "rparen") {
      args.push(this.eatValue());
      while (this.maybe("comma")) args.push(this.eatValue());
    }
    this.expect("rparen");
    this.expect("semi");
    return { kind: "call", name, args };
  }

  private eatValue(): string {
    const t = this.peek();
    if (t.kind === "ident" || t.kind === "number" || t.kind === "string") {
      this.eat();
      return t.value;
    }
    throw new RhoQuError(`expected value (identifier, number, or string), got '${t.value}'`, t.line, t.col);
  }
}

// ---------------------------------------------------------------------------
// Interpreter / transpiler
// ---------------------------------------------------------------------------

/// Substitute `$name` references in `text` with the bound values from `env`.
/// Substitution is whole-token: `$x` is replaced when followed by a
/// non-identifier character or end-of-string. `$$` escapes a literal `$`.
function substitute(text: string, env: Map<string, string>): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "$" && text[i + 1] === "$") { out += "$"; i += 2; continue; }
    if (text[i] === "$") {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_\-]/.test(text[j])) j++;
      const name = text.slice(i + 1, j);
      const val = env.get(name);
      if (val === undefined) {
        // Unknown binding: leave the $name in place (lets users include literal $names).
        out += text.slice(i, j);
      } else {
        out += val;
      }
      i = j;
    } else {
      out += text[i]; i++;
    }
  }
  return out;
}

/// Transpile a RhoQu program into a flat list of /command strings.
/// Throws RhoQuError on parse or expansion failure.
export function transpile(source: string): string[] {
  const tokens = tokenize(source);
  const program = new Parser(tokens).parseProgram();
  const out: string[] = [];
  const env = new Map<string, string>();
  emitStmts(program.top, program, env, out);
  return out;
}

function emitStmts(stmts: Stmt[], program: Program, env: Map<string, string>, out: string[]): void {
  for (const s of stmts) emitStmt(s, program, env, out);
}

function emitStmt(s: Stmt, program: Program, env: Map<string, string>, out: string[]): void {
  if (s.kind === "new") {
    for (const name of s.names) out.push(`/grant ${name}`);
    return;
  }
  if (s.kind === "parallel") {
    emitStmts(s.body, program, env, out);   // sequential expansion; true parallel = separate peers
    return;
  }
  if (s.kind === "cmd") {
    out.push(substitute(s.text, env));
    return;
  }
  if (s.kind === "call") {
    const def = program.defs.get(s.name);
    if (!def) throw new RhoQuError(`unknown process '${s.name}'`, 0, 0);
    if (def.params.length !== s.args.length) {
      throw new RhoQuError(
        `process '${s.name}' takes ${def.params.length} args, got ${s.args.length}`, 0, 0);
    }
    // Bind args in a fresh child env. Argument values are themselves
    // substituted against the caller's env so a process can pass through
    // its own bindings.
    const childEnv = new Map(env);
    for (let k = 0; k < def.params.length; k++) {
      const argVal = substitute(s.args[k], env);
      // Strip surrounding quotes from string literals so callers don't have
      // to be aware of token types when passing values into /commands.
      const stripped = (argVal.startsWith('"') && argVal.endsWith('"'))
                    || (argVal.startsWith("'") && argVal.endsWith("'"))
        ? argVal.slice(1, -1)
        : argVal;
      childEnv.set(def.params[k], stripped);
    }
    emitStmts(def.body, program, childEnv, out);
    return;
  }
}

export { RhoQuError };
