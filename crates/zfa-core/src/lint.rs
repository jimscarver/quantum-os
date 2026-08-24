//! Lightweight, heuristic rholang source linter.
//!
//! This is the browser-side "code safety" pass from the `/global` macro-agent
//! spec: before a macro-expanded deploy is signed and broadcast, the client runs
//! this check and shows the user exactly what would execute. It is *not* a full
//! parser — it catches the two classes of problem that matter for a macro that
//! was already assembled from approved templates:
//!
//!   1. delimiter balance (a malformed expansion),
//!   2. restricted patterns (raw I/O channels, unforgeable-identity capture,
//!      classic send/eval injection shapes).
//!
//! Compiled to WASM (`wasm_lint_ok` / `wasm_lint_errors`) and mirrored in the
//! agent's `global-macros.mjs` hygiene guard.

/// A single lint finding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    /// Byte offset in the source (best effort).
    pub pos: usize,
    pub message: String,
}

/// Lint a rholang source string. An empty result means "no findings".
pub fn lint(source: &str) -> Vec<Finding> {
    let mut findings = Vec::new();

    // 1. Delimiter balance: (), {}, [].
    for (open, close, name) in [
        ('(', ')', "paren"),
        ('{', '}', "brace"),
        ('[', ']', "bracket"),
    ] {
        let mut depth: i32 = 0;
        for (i, c) in source.char_indices() {
            if c == open {
                depth += 1;
            } else if c == close {
                depth -= 1;
                if depth < 0 {
                    findings.push(Finding {
                        pos: i,
                        message: format!("unbalanced {name}s (unexpected `{close}`)"),
                    });
                    break;
                }
            }
        }
        if depth != 0 {
            findings.push(Finding {
                pos: source.len(),
                message: format!("unbalanced {name}s ({depth} unclosed)"),
            });
        }
    }

    // 2. Restricted patterns (ordered by severity).
    for (needle, why) in [
        ("rho:io:", "unauthorized raw I/O channel"),
        (
            "rho:rchain:deployerId",
            "deployerId capture — a macro must not bind another signer's identity",
        ),
        ("for(", "join pattern — a macro must not introduce its own join"),
        ("* !", "eval-then-send injection"),
        ("! *", "send-then-eval injection"),
        ("!!", "double-send"),
    ] {
        if let Some(pos) = source.find(needle) {
            findings.push(Finding {
                pos,
                message: format!("{why}: `{needle}`"),
            });
        }
    }

    findings
}

/// True when the source has no findings.
pub fn lint_ok(source: &str) -> bool {
    lint(source).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_contract_lints_clean() {
        let src = r#"new ret in {
  rho:registry:insertArbitrary!({"directory": "notes"}, *ret) |
  for (@uri <- ret) { Nil }
}"#;
        assert!(lint(src).is_empty(), "{:?}", lint(src));
    }

    #[test]
    fn flags_unbalanced_paren() {
        let f = lint("new ret in { rho:qucalc:grant!([0,1], *ret ");
        assert!(f.iter().any(|x| x.message.contains("unbalanced")));
    }

    #[test]
    fn flags_raw_io() {
        let f = lint("new ret in { rho:io:stdout!(\"hi\", *ret) }");
        assert!(f.iter().any(|x| x.message.contains("rho:io:")));
    }

    #[test]
    fn flags_deployerid_capture() {
        let f = lint("new x in { rho:rchain:deployerId!(*x) }");
        assert!(f.iter().any(|x| x.message.contains("deployerId")));
    }

    #[test]
    fn flags_injection_shapes() {
        assert!(lint("a! *x").iter().any(|x| x.message.contains("injection")));
        assert!(lint("x!!").iter().any(|x| x.message.contains("double-send")));
    }

    #[test]
    fn ok_helper_agrees() {
        assert!(lint_ok("new ret in { Nil }"));
        assert!(!lint_ok("rho:io:stdout!(1)"));
    }
}
