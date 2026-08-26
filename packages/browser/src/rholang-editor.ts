/// A rholang editor, in a modal, with syntax highlighting.
///
/// A chat input is the wrong place to write a program: it is one line tall,
/// Enter submits, indentation is invisible, and the command that opens it can
/// be mistaken for a command that wants no argument. So `/rholang eval` and
/// `/rholang deploy` open this instead.
///
/// The highlighting is the ordinary textarea-over-`<pre>` overlay: a
/// transparent textarea holds the text and the caret, a `<pre>` behind it
/// shows the same text marked up, and the two scroll together. Both must use
/// identical font, padding, and line-height or the layers drift apart.

/** Words that are rholang's own, not a program's. */
const KEYWORDS = new Set([
  "new", "in", "for", "contract", "match", "if", "else", "select", "bundle",
  "let", "Nil", "true", "false", "not", "and", "or", "matches",
]);

/** Types that appear in patterns. */
const TYPES = new Set(["Bool", "Int", "String", "Uri", "ByteArray", "Set", "Map", "List"]);

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const span = (cls: string, text: string): string => `<span class="rh-${cls}">${esc(text)}</span>`;

/**
 * Mark up rholang as HTML.
 *
 * A single left-to-right pass, because the constructs that must win — comments,
 * strings, and backtick uris — are exactly the ones whose contents must *not*
 * be tokenized further. Anything unrecognized passes through escaped, so the
 * text always renders even when the highlighter does not understand it.
 *
 * @param src   program text
 * @param scope names the wrapper puts in scope (`return`, the powerbox); shown
 *              distinctly so it is clear which names come for free.
 */
export function highlightRholang(src: string, scope: readonly string[] = []): string {
  const inScope = new Set(scope);
  let out = "";
  let i = 0;

  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);

    // Block comment — runs to `*/` or to the end if never closed.
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += span("comment", src.slice(i, stop));
      i = stop;
      continue;
    }

    // Line comment.
    if (two === "//") {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? src.length : nl;
      out += span("comment", src.slice(i, stop));
      i = stop;
      continue;
    }

    // String literal, honouring backslash escapes.
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, src.length);
      out += span("string", src.slice(i, stop));
      i = stop;
      continue;
    }

    // Backtick uri — `rho:qucalc:zfa` and friends. The powerbox lives here, so
    // it gets its own colour rather than sharing the string one.
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      const stop = end === -1 ? src.length : end + 1;
      out += span("uri", src.slice(i, stop));
      i = stop;
      continue;
    }

    // Number.
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < src.length && src[j] >= "0" && src[j] <= "9") j++;
      out += span("num", src.slice(i, j));
      i = j;
      continue;
    }

    // Identifier — keyword, type, in-scope name, or the program's own.
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_']/.test(src[j])) j++;
      const word = src.slice(i, j);
      const cls = KEYWORDS.has(word) ? "kw"
                : TYPES.has(word)    ? "type"
                : inScope.has(word)  ? "scope"
                : "ident";
      out += span(cls, word);
      i = j;
      continue;
    }

    // Name sigils and the send/receive arrows, which carry most of the meaning
    // in a rholang line and are easy to miss unstyled.
    if (c === "@" || c === "*") { out += span("sigil", c); i++; continue; }
    if (two === "<-" || two === "<=" || two === "=>" || two === "!!") {
      out += span("op", two); i += 2; continue;
    }
    if (c === "!" || c === "|") { out += span("op", c); i++; continue; }

    out += esc(c);
    i++;
  }
  return out;
}

const CSS = `
.rh-wrap { position: relative; border: 1px solid #3a3d46; border-radius: 6px;
           background: #0f1013; overflow: hidden; }
.rh-wrap pre, .rh-wrap textarea {
  margin: 0; padding: 10px 12px; border: 0; box-sizing: border-box;
  font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap; word-break: break-word; overflow-wrap: break-word;
  tab-size: 2;
}
.rh-wrap pre { position: absolute; inset: 0; overflow: auto; pointer-events: none;
               color: #e8e8ea; }
.rh-wrap textarea {
  position: relative; display: block; width: 100%; height: 300px; resize: vertical;
  background: transparent; color: transparent; caret-color: #e8e8ea; outline: none;
}
.rh-wrap textarea::selection { background: #3b6ef5; color: transparent; }
.rh-comment { color: #6b7280; font-style: italic; }
.rh-string  { color: #a3e635; }
.rh-uri     { color: #f0abfc; }
.rh-num     { color: #fbbf24; }
.rh-kw      { color: #60a5fa; font-weight: 600; }
.rh-type    { color: #38bdf8; }
.rh-scope   { color: #2dd4bf; }
.rh-op      { color: #f87171; }
.rh-sigil   { color: #f87171; }
.rh-ident   { color: #e8e8ea; }
`;

function ensureStyles(): void {
  if (document.getElementById("rholang-editor-css")) return;
  const el = document.createElement("style");
  el.id = "rholang-editor-css";
  el.textContent = CSS;
  document.head.appendChild(el);
}

export interface RholangEditorOptions {
  mode: "eval" | "deploy";
  /** Prefilled program text. */
  seed?: string;
  /** Names the wrapper declares, highlighted as free. */
  scope: readonly string[];
  /** Where the program will run, shown so it is never a surprise. */
  nodeUrl: string;
  /** Check the program's shape; the result is shown live under the editor. */
  lint?: (source: string) => Promise<{ ok: boolean; errors: string[] }>;
  /**
   * localStorage key holding the working program. Getting a program right is
   * iterative — run it, read the error, change one thing, run it again — and
   * that loop is lost if the editor opens empty every time. Kept until it is
   * cleared, including after a successful run, so a working program can be
   * tweaked or saved rather than retyped.
   */
  draftKey?: string;
}

/** localStorage can throw outright (private mode, blocked site data). */
function readDraft(key: string | undefined): string {
  if (!key) return "";
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}

function writeDraft(key: string | undefined, text: string): void {
  if (!key) return;
  try { localStorage.setItem(key, text); } catch { /* nothing to do about it */ }
}

/**
 * Open the editor. Resolves with the program, or `null` if it was cancelled.
 *
 * Deliberately does not run anything itself — the caller owns lint-and-run, so
 * this stays a text editor and nothing more.
 */
export function openRholangEditor(opts: RholangEditorOptions): Promise<string | null> {
  ensureStyles();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px";

    const card = document.createElement("div");
    card.style.cssText = "background:#1b1d23;color:#e8e8ea;border:1px solid #3a3d46;border-radius:10px;max-width:760px;width:100%;padding:18px;box-shadow:0 8px 40px rgba(0,0,0,.5);font:14px/1.5 system-ui,sans-serif";

    const h = document.createElement("div");
    h.textContent = opts.mode === "eval" ? "rholang — evaluate" : "rholang — deploy";
    h.style.cssText = "font-weight:600;font-size:15px;margin-bottom:2px";
    card.appendChild(h);

    const sub = document.createElement("div");
    sub.textContent = opts.mode === "eval"
      ? `runs read-only on ${opts.nodeUrl} — no block, no cost`
      : `signed and submitted to ${opts.nodeUrl} — costs phlo, lands in a block`;
    sub.style.cssText = "font-size:12px;opacity:.7;margin-bottom:10px";
    card.appendChild(sub);

    const wrap = document.createElement("div");
    wrap.className = "rh-wrap";
    const pre = document.createElement("pre");
    const ta = document.createElement("textarea");
    ta.spellcheck = false;
    ta.value = opts.seed || readDraft(opts.draftKey);
    ta.placeholder = "return!(6 * 7)";
    wrap.appendChild(pre);
    wrap.appendChild(ta);
    card.appendChild(wrap);

    const scopeLine = document.createElement("div");
    scopeLine.innerHTML = "in scope: " + opts.scope.map((n) => `<span class="rh-scope">${esc(n)}</span>`).join(", ");
    scopeLine.style.cssText = "font:12px/1.5 ui-monospace,monospace;opacity:.85;margin-top:8px";
    card.appendChild(scopeLine);

    const status = document.createElement("div");
    status.style.cssText = "font:12px/1.5 ui-monospace,monospace;min-height:18px;margin-top:4px";
    card.appendChild(status);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:12px";
    // Open a .rho from disk. The file never leaves the browser — it is read
    // into the textarea, and what runs is whatever the editor holds when you
    // press the button, the same as if it had been typed.
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".rho,.rholang,text/plain";
    fileInput.style.display = "none";
    const openBtn = document.createElement("button");
    openBtn.textContent = "Open .rho…";
    openBtn.title = "Load a rholang file from this device";
    openBtn.style.cssText = "background:#2a2d35;color:#e8e8ea;border:1px solid #3a3d46;border-radius:6px;padding:7px 12px;cursor:pointer";

    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear";
    clearBtn.title = "Empty the editor";
    clearBtn.style.cssText = "background:#2a2d35;color:#e8e8ea;border:1px solid #3a3d46;border-radius:6px;padding:7px 12px;cursor:pointer";

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save .rho";
    saveBtn.title = "Download what is in the editor";
    saveBtn.style.cssText = "background:#2a2d35;color:#e8e8ea;border:1px solid #3a3d46;border-radius:6px;padding:7px 12px;cursor:pointer";

    const hint = document.createElement("div");
    hint.textContent = "Ctrl+Enter to run · Esc to cancel · drop a .rho here";
    hint.style.cssText = "margin-right:auto;font-size:12px;opacity:.6";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = "background:#2a2d35;color:#e8e8ea;border:1px solid #3a3d46;border-radius:6px;padding:7px 14px;cursor:pointer";
    const okBtn = document.createElement("button");
    okBtn.textContent = opts.mode === "eval" ? "Evaluate" : "Sign and deploy";
    okBtn.style.cssText = "background:#3b6ef5;color:#fff;border:none;border-radius:6px;padding:7px 14px;cursor:pointer;font-weight:600";
    btnRow.appendChild(openBtn);
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(clearBtn);
    btnRow.appendChild(hint);
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    card.appendChild(btnRow);

    card.appendChild(fileInput);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const paint = (): void => {
      // A trailing newline collapses in `pre`, so the last line would sit
      // unhighlighted under the caret without this.
      pre.innerHTML = highlightRholang(ta.value, opts.scope) + "\n";
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    };

    let lintTimer: ReturnType<typeof setTimeout> | undefined;
    const relint = (): void => {
      if (!opts.lint) return;
      clearTimeout(lintTimer);
      lintTimer = setTimeout(() => {
        const source = ta.value.trim();
        if (!source) { status.textContent = ""; return; }
        void opts.lint!(source).then((r) => {
          if (r.ok) {
            status.textContent = "✓ well-formed";
            status.style.color = "#4ade80";
          } else {
            status.textContent = "✗ " + (r.errors[0] ?? "malformed");
            status.style.color = "#f87171";
          }
        }).catch(() => { status.textContent = ""; });
      }, 300);
    };

    /** Name of the file last opened, so Save offers it back. */
    let loadedName = "";

    /** Put a file's text in the editor, replacing what is there. */
    const loadFile = (file: File): void => {
      loadedName = file.name;
      const reader = new FileReader();
      reader.onload = () => {
        ta.value = String(reader.result ?? "");
        paint();
        relint();
        writeDraft(opts.draftKey, ta.value);
        status.textContent = `loaded ${file.name}`;
        status.style.color = "";
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      };
      reader.onerror = () => {
        status.textContent = `✗ could not read ${file.name}`;
        status.style.color = "#f87171";
      };
      reader.readAsText(file);
    };

    openBtn.addEventListener("click", () => fileInput.click());

    // Save what is in the editor. A program worth deploying is worth keeping,
    // and a deploy is permanent — the source that produced it should not live
    // only in a modal. Round-trips the opened name so open/edit/save keeps it.
    saveBtn.addEventListener("click", () => {
      const text = ta.value;
      if (!text.trim()) { status.textContent = "nothing to save"; status.style.color = ""; return; }
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = loadedName || `program-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.rho`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next tick — revoking synchronously can cancel the download.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      status.textContent = `saved ${a.download}`;
      status.style.color = "";
    });
    fileInput.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (f) loadFile(f);
      // Clear it, so choosing the same file twice in a row still fires `change`.
      fileInput.value = "";
    });

    // Drag a .rho onto the editor. preventDefault on dragover is what tells the
    // browser this is a drop target at all; without it the page navigates to
    // the file instead.
    const stop = (e: DragEvent): void => { e.preventDefault(); e.stopPropagation(); };
    wrap.addEventListener("dragover", (e) => { stop(e); wrap.style.borderColor = "#3b6ef5"; });
    wrap.addEventListener("dragleave", (e) => { stop(e); wrap.style.borderColor = "#3a3d46"; });
    wrap.addEventListener("drop", (e) => {
      stop(e);
      wrap.style.borderColor = "#3a3d46";
      const f = e.dataTransfer?.files?.[0];
      if (f) loadFile(f);
    });

    clearBtn.addEventListener("click", () => {
      ta.value = "";
      loadedName = "";
      writeDraft(opts.draftKey, "");
      paint();
      status.textContent = "";
      ta.focus();
    });

    ta.addEventListener("input", () => { paint(); relint(); writeDraft(opts.draftKey, ta.value); });
    ta.addEventListener("scroll", () => { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; });
    paint();
    relint();
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);

    let done = false;
    const close = (result: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(lintTimer);
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(result);
    };
    const submit = (): void => {
      const source = ta.value.trim();
      close(source ? source : null);
    };

    ta.addEventListener("keydown", (e) => {
      // Tab indents rather than leaving the editor — this is a code field, and
      // a program of any size is unreadable without it.
      if (e.key === "Tab") {
        e.preventDefault();
        const s = ta.selectionStart, t = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + "  " + ta.value.slice(t);
        ta.selectionStart = ta.selectionEnd = s + 2;
        paint(); relint(); writeDraft(opts.draftKey, ta.value);
      }
    });

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    };
    document.addEventListener("keydown", onKey, true);
    cancelBtn.addEventListener("click", () => close(null));
    okBtn.addEventListener("click", submit);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
  });
}
