//! Conformance of the ZFA kernel against the QLF census.
//!
//! `tests/data/census_inventory.json` is an exhaustive census of the 8-twist
//! alphabet, computed in a different repo, in a different language, by a
//! different program (`census_inventory.py` in the Quantum Logical Framework),
//! and cross-checked there against machine-verified Lean theorems.
//!
//! These tests re-derive every one of its numbers here, by brute force, using
//! only this crate's own kernel. Nothing is sampled and nothing is fixtured:
//! the suite enumerates the whole alphabet at lengths 2, 4 and 6 — 266,304
//! histories — folds each one, and requires the totals to match the census
//! exactly. A sign flip in `twist_matrix`, a wrong branch in
//! `is_pauli_closed`, or a drifted `Twist` encoding moves at least one total
//! and fails here.
//!
//! That is the point of the file. The crate's other tests are 25 hand-picked
//! cases; this one is the alphabet.
//!
//! Length 8 (16,777,216 histories) is the same check one rung further out,
//! and it passes. It is `#[ignore]`d only so `cargo test` stays fast — run it
//! with `cargo test -p zfa-core -- --ignored` (~3 minutes in debug).

use std::collections::BTreeMap;

use zfa_core::coupling::{classify_join, Coupling};
use zfa_core::history::{is_count_balanced, is_pairwise_balanced};
use zfa_core::pauli::{is_pauli_closed, pauli_fold};
use zfa_core::twist::Twist;

const CENSUS: &str = include_str!("data/census_inventory.json");

/// The μ₄ phase of a history whose fold is a scalar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Plus,
    Minus,
    Imaginary,
}

/// The scalar phase of a Pauli fold, or `None` if the fold is not a scalar.
fn fold_phase(h: &[Twist]) -> Option<Phase> {
    if !is_pauli_closed(h) {
        return None;
    }
    let (re, im) = pauli_fold(h).a;
    // Entries are exact small integers in {-1, 0, 1}; the tolerance is only
    // insurance against a future change to the arithmetic.
    if im.abs() > 0.5 {
        Some(Phase::Imaginary)
    } else if re > 0.5 {
        Some(Phase::Plus)
    } else {
        Some(Phase::Minus)
    }
}

/// Every history of the given length, in odometer order.
fn for_each_history(len: u32, mut f: impl FnMut(&[Twist])) {
    let total = 8u64.pow(len);
    let mut h = vec![Twist::Up; len as usize];
    for n in 0..total {
        let mut rest = n;
        for slot in h.iter_mut() {
            *slot = Twist::from_u8((rest % 8) as u8).expect("digit is 0..7");
            rest /= 8;
        }
        f(&h);
    }
}

fn census() -> serde_json::Value {
    serde_json::from_str(CENSUS).expect("census fixture is valid JSON")
}

fn expect_i64(v: &serde_json::Value, path: &[&str]) -> i64 {
    let mut cur = v;
    for key in path {
        cur = cur.get(key).unwrap_or_else(|| panic!("census has no {path:?}"));
    }
    cur.as_i64()
        .unwrap_or_else(|| panic!("census {path:?} is not an integer"))
}

/// Tally of one length's fold census, derived here from the kernel alone.
#[derive(Default, Debug)]
struct Tally {
    balanced: i64,
    n_plus: i64,
    n_minus: i64,
    n_imaginary: i64,
    /// Count-balanced histories whose fold is *not* a Pauli scalar. The QLF
    /// keystone `count_balanced_pauli_closed` says there are none.
    keystone_counterexamples: Vec<String>,
    /// Histories where the parity shortcut and the matrix fold disagree.
    parity_disagreements: Vec<String>,
}

fn render(h: &[Twist]) -> String {
    h.iter().map(|t| t.symbol()).collect()
}

fn tally(len: u32) -> Tally {
    let mut t = Tally::default();
    for_each_history(len, |h| {
        // Checked over the *whole* alphabet, not just the balanced part: the
        // parity criterion in `coupling` must decide Pauli closure for open
        // factors too, which is exactly where it gets used.
        if zfa_core::coupling::folds_to_scalar(h) != is_pauli_closed(h) {
            t.parity_disagreements.push(render(h));
        }
        if !is_pairwise_balanced(h) {
            return;
        }
        t.balanced += 1;
        match fold_phase(h) {
            Some(Phase::Plus) => t.n_plus += 1,
            Some(Phase::Minus) => t.n_minus += 1,
            Some(Phase::Imaginary) => t.n_imaginary += 1,
            None => t.keystone_counterexamples.push(render(h)),
        }
    });
    t
}

fn check_fold_census(len: u32) {
    let db = census();
    let key = len.to_string();
    let at = |field: &str| expect_i64(&db, &["folds", "by_length", &key, field]);

    let t = tally(len);

    assert!(
        t.keystone_counterexamples.is_empty(),
        "count balance must imply Pauli closure (count_balanced_pauli_closed), \
         but {} histories of length {} break it, e.g. {:?}",
        t.keystone_counterexamples.len(),
        len,
        &t.keystone_counterexamples[..t.keystone_counterexamples.len().min(5)]
    );
    assert!(
        t.parity_disagreements.is_empty(),
        "coupling::folds_to_scalar must agree with the matrix fold, but {} \
         histories of length {} disagree, e.g. {:?}",
        t.parity_disagreements.len(),
        len,
        &t.parity_disagreements[..t.parity_disagreements.len().min(5)]
    );

    assert_eq!(t.balanced, at("count"), "balanced count, length {len}");
    assert_eq!(t.n_plus, at("n_plus"), "n_plus, length {len}");
    assert_eq!(t.n_minus, at("n_minus"), "n_minus, length {len}");
    assert_eq!(
        t.n_imaginary,
        at("n_imaginary"),
        "n_imaginary, length {len} — a count-balanced fold is real (balanced_phase_is_real)"
    );

    let signed = t.n_plus - t.n_minus;
    assert_eq!(signed, at("signed_amplitude"), "signed amplitude, length {len}");
    assert_eq!(
        signed * signed,
        at("weight_of_signed_amplitude"),
        "weight of the signed amplitude, length {len}"
    );
}

#[test]
fn fold_census_length_2() {
    check_fold_census(2);
}

#[test]
fn fold_census_length_4() {
    check_fold_census(4);
}

#[test]
fn fold_census_length_6() {
    check_fold_census(6);
}

#[test]
#[ignore = "16.7M histories, ~90s each in debug; run with cargo test -- --ignored"]
fn fold_census_length_8() {
    check_fold_census(8);
}

/// The census's negative control. Count balance forces the fold to be real, so
/// the imaginary sector has to be reachable *somewhere* or that fact is vacuous
/// — it is reached by unbalanced histories, 48 of them at length 3.
#[test]
fn unbalanced_histories_do_reach_the_imaginary_sector() {
    let expected = expect_i64(&census(), &["folds", "unbalanced_imaginary_count_len3"]);
    let mut found = 0i64;
    for_each_history(3, |h| {
        if !is_pairwise_balanced(h) && fold_phase(h) == Some(Phase::Imaginary) {
            found += 1;
        }
    });
    assert_eq!(found, expected, "unbalanced histories folding to ±iI at length 3");
}

/// The sector counts behind the room's coupling metric.
///
/// Every balanced history is cut at every interior point; each cut is one way
/// of reading it as two indexed subsystems. `coupling::classify_join` must
/// sort those cuts into the same three bins the census does.
fn check_factor_census(len: u32) {
    let db = census();
    let key = len.to_string();
    let at = |field: &str| expect_i64(&db, &["factors", &key, field]);

    let mut sectors: BTreeMap<&'static str, i64> = BTreeMap::new();
    for_each_history(len, |h| {
        if !is_pairwise_balanced(h) {
            return;
        }
        for cut in 1..h.len() {
            let bin = match classify_join(&h[..cut], &h[cut..]) {
                Coupling::Independent => "independent_pairs",
                Coupling::Product => "product_sector",
                Coupling::Coupled => "coupled_sector",
                // A cut of a closed history is still that closed history, so
                // the join always closes.
                Coupling::Open => unreachable!("a cut of a closure still closes"),
            };
            *sectors.entry(bin).or_default() += 1;
        }
    });

    let independent = sectors.get("independent_pairs").copied().unwrap_or(0);
    let product = sectors.get("product_sector").copied().unwrap_or(0);
    let coupled = sectors.get("coupled_sector").copied().unwrap_or(0);

    assert_eq!(independent, at("independent_pairs"), "independent pairs, length {len}");
    assert_eq!(product, at("product_sector"), "product sector, length {len}");
    assert_eq!(coupled, at("coupled_sector"), "coupled sector, length {len}");
    assert_eq!(
        product + coupled,
        at("shared_closures"),
        "shared closures are the product and coupled sectors, length {len}"
    );

    let fraction = coupled as f64 / (product + coupled) as f64;
    let expected = db["factors"][&key]["coupled_fraction"]
        .as_f64()
        .expect("coupled_fraction is a number");
    assert!(
        (fraction - expected).abs() < 5e-7,
        "coupled fraction, length {len}: got {fraction}, census says {expected}"
    );
}

#[test]
fn factor_census_length_2() {
    check_factor_census(2);
}

#[test]
fn factor_census_length_4() {
    check_factor_census(4);
}

#[test]
fn factor_census_length_6() {
    check_factor_census(6);
}

#[test]
#[ignore = "16.7M histories, ~90s each in debug; run with cargo test -- --ignored"]
fn factor_census_length_8() {
    check_factor_census(8);
}

/// The baseline the room reads its own coupling against must be the one the
/// census measured, not a number that drifted out of the doc comment.
#[test]
fn coupled_baseline_matches_the_census() {
    let expected = census()["factors"]["8"]["coupled_fraction"]
        .as_f64()
        .expect("coupled_fraction is a number");
    assert_eq!(zfa_core::coupling::COUPLED_BASELINE, expected);
}

/// # The gap between this crate's `achieves_zfa` and QLF's
///
/// The census above is counted with [`is_pairwise_balanced`], QLF's count
/// balance. `zfa_core::history::achieves_zfa` uses the aggregate
/// [`is_count_balanced`] instead, which is strictly weaker — and the gap is
/// not marginal, so it is pinned here with exact numbers rather than left to
/// a doc comment.
///
/// Two things break under the aggregate reading:
///
/// 1. The keystone fails. `count_balanced_pauli_closed` says count balance
///    implies Pauli closure; under the aggregate predicate there are 61,440
///    counterexamples at length 6 alone.
/// 2. `achieves_zfa` over-accepts. At length 6 it admits 20,480 histories as
///    ZFA where QLF admits 5,120 — three quarters of what it calls a closure
///    has a non-zero signed action vector.
///
/// This test does not assert that the situation is correct. It asserts that it
/// is exactly this size, so that a change either way is visible.
#[test]
fn the_aggregate_predicate_gap_is_exactly_this_wide() {
    // (length, aggregate-balanced-but-not-Pauli-closed, achieves_zfa accepts, QLF ZFA)
    let expected = [(2u32, 24i64, 8i64, 8i64), (4, 1152, 384, 168), (6, 61440, 20480, 5120)];

    for (len, keystone_breaks, accepts, genuine) in expected {
        let (mut breaks, mut acc, mut gen) = (0i64, 0i64, 0i64);
        for_each_history(len, |h| {
            let aggregate = is_count_balanced(h);
            let closed = is_pauli_closed(h);
            if aggregate && !closed {
                breaks += 1;
            }
            if aggregate && closed {
                acc += 1;
            }
            if is_pairwise_balanced(h) {
                gen += 1;
            }
        });
        assert_eq!(
            breaks, keystone_breaks,
            "length {len}: aggregate balance without Pauli closure — the keystone \
             does not hold for `is_count_balanced`"
        );
        assert_eq!(acc, accepts, "length {len}: histories `achieves_zfa` accepts");
        assert_eq!(gen, genuine, "length {len}: histories that are QLF ZFA");
        assert!(
            acc >= gen,
            "length {len}: the aggregate predicate can only ever over-accept"
        );
    }
}
