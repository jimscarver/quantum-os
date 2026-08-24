//! Lightweight rholang well-formedness check.
//!
//! Runs before a macro-expanded deploy is signed, so the user is not asked to
//! sign something that cannot parse. It checks delimiter balance and nothing
//! else. It is not a full parser.
//!
//! It deliberately does NOT restrict which rholang a deploy may contain. There
//! is no forbidden rholang: RChain's security is capability-based, so what a
//! deploy can reach is decided by the unforgeable names it holds, not by which
//! identifiers appear in its source. A denylist here decided nothing the node
//! does not already decide, while refusing legitimate programs — the list it
//! replaced flagged `for(`, which is ordinary rholang, and `rho:io:`, which any
//! deploy may use.
//!
//! Compiled to WASM (`wasm_lint_ok` / `wasm_lint_errors`).

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

    /// There is no forbidden rholang. Capability security decides what a deploy
    /// can reach; the linter only decides whether it is well-formed.
    #[test]
    fn does_not_restrict_which_rholang_is_permitted() {
        for src in [
            "new ret in { rho:io:stdout!(\"hi\", *ret) }",
            "new x in { rho:rchain:deployerId!(*x) }",
            "for (@x <- @\"c\") { Nil }",
            "new c in { c!!(1) }",
        ] {
            assert!(lint(src).is_empty(), "{src:?} -> {:?}", lint(src));
        }
    }

    #[test]
    fn ok_helper_agrees() {
        assert!(lint_ok("new ret in { Nil }"));
        assert!(!lint_ok("new ret in { Nil "));
    }
}
