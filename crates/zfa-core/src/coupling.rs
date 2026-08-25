//! Coupling: was a joint closure genuinely shared, or two closures side by side?
//!
//! A room process is `parallel(peer_1, peer_2, …)`, and QLF proves that such a
//! composition is ZFA-balanced **by construction**
//! (`bra_ket_always_balanced`). That is a theorem about the constructor, so
//! "the room process is ZFA-balanced" is true of every room and distinguishes
//! nothing — it changes no count of ways. This module is what makes the room's
//! balance carry information: it asks *how* the parts closed.
//!
//! Cut a closed joint history into its per-peer factors. Exactly one of four
//! things is true:
//!
//! | verdict | meaning |
//! |---|---|
//! | [`Coupling::Open`] | the join does not close at all — not an event |
//! | [`Coupling::Independent`] | every factor closes on its own — two closures, not one |
//! | [`Coupling::Product`] | no factor is count-balanced, yet each folds to a Pauli scalar — separable, tensor-valid |
//! | [`Coupling::Coupled`] | some factor neither closes nor folds to a scalar — only the join closes |
//!
//! Closure here means QLF's ZFA — [`achieves_zfa_pairwise`], the pairwise
//! predicate the census counts — not the crate's weaker aggregate
//! `achieves_zfa`. See the note on [`crate::history::achieves_zfa`].
//!
//! `Coupled` is QLF's `SharedClosure`: the factors are not separately
//! describable, and indexing them as independent subsystems (`σ ⊗ I`,
//! `I ⊗ σ`) cannot reproduce the join — it is a genuine Pauli string. That is
//! entanglement, and in a room it is the difference between *"we decided this
//! together"* and *"we each happened to be fine."*
//!
//! The classification is not a heuristic. It is the same cut-and-classify the
//! QLF census performs over every balanced history, so the room's verdict has
//! an exact baseline to be read against ([`COUPLED_BASELINE`]), and
//! `tests/census_conformance.rs` re-derives the census sector counts from this
//! module and requires them to match.

use crate::history::{achieves_zfa_pairwise, is_pairwise_balanced};
use crate::twist::Twist;

/// How the factors of a joint history relate to the closure they form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Coupling {
    /// The join is not a ZFA closure — there is no event to classify.
    Open,
    /// Every factor is count-balanced: each closed on its own. Two closures
    /// that happened side by side, not one shared event.
    Independent,
    /// No factor closes alone, but each still folds to a Pauli scalar. The
    /// join is separable: `σ ⊗ I` and `I ⊗ σ` reproduce it.
    Product,
    /// Some factor neither closes nor folds to a scalar. Only the join
    /// closes — a shared closure, QLF's entanglement.
    Coupled,
}

impl Coupling {
    /// A one-line reading for a room log.
    pub fn describe(self) -> &'static str {
        match self {
            Coupling::Open => "open — the join does not close; no event",
            Coupling::Independent => "independent — each part closed alone; two closures, not one",
            Coupling::Product => "product — separable; each part folds to a scalar on its own",
            Coupling::Coupled => "coupled — only the join closes; a shared closure",
        }
    }

    /// The verdict's wire name, as the browser and the JSON reading spell it.
    pub fn name(self) -> &'static str {
        match self {
            Coupling::Open => "open",
            Coupling::Independent => "independent",
            Coupling::Product => "product",
            Coupling::Coupled => "coupled",
        }
    }

    /// True for the two verdicts the census calls a *shared closure*: the join
    /// is one event rather than several. `independent_pairs` are excluded by
    /// the census for exactly this reason, and so are they here.
    pub fn is_shared_closure(self) -> bool {
        matches!(self, Coupling::Product | Coupling::Coupled)
    }
}

/// Parity of the X, Y and Z letter multiplicities. Gauge twists (`+`, `-`)
/// carry no axis and are not counted.
pub fn axis_parities(h: &[Twist]) -> (bool, bool, bool) {
    let (mut x, mut y, mut z) = (0u32, 0u32, 0u32);
    for t in h {
        match t {
            Twist::Right | Twist::Left => x += 1,
            Twist::Up | Twist::Down => y += 1,
            Twist::Slash | Twist::BSlash => z += 1,
            Twist::Plus | Twist::Minus => {}
        }
    }
    (x % 2 == 1, y % 2 == 1, z % 2 == 1)
}

/// True iff this history's Pauli fold is a scalar — i.e. iff it is
/// [`crate::pauli::is_pauli_closed`], decided by parity instead of by
/// multiplying matrices.
///
/// In `QLF_TwistAlphabet`'s `(ZMod 2)²` embedding (`X ↦ (1,0)`, `Y ↦ (0,1)`,
/// `Z ↦ (1,1)`) the fold is `phase • axisMatrix(axisProd)`, so it is a scalar
/// exactly when `axisProd = I`, which is exactly when the three axis
/// multiplicities share a parity. This is strictly weaker than count balance:
/// an *open* factor of a closure can still fold to a scalar, and that is the
/// distinction between the product and coupled sectors.
///
/// `tests/census_conformance.rs` checks this agrees with the matrix fold on
/// every history up to length 6 — 266,304 of them.
pub fn folds_to_scalar(h: &[Twist]) -> bool {
    let (x, y, z) = axis_parities(h);
    x == y && y == z
}

/// Classify a two-factor join. `a` and `b` are the two parts, in order.
pub fn classify_join(a: &[Twist], b: &[Twist]) -> Coupling {
    classify_parts(&[a, b])
}

/// Classify an n-factor join — the room case, one factor per peer, in the
/// order the room composed them.
///
/// For two parts this is exactly the census's cut classification; for more it
/// is the same three questions asked of every part.
pub fn classify_parts(parts: &[&[Twist]]) -> Coupling {
    let joint: Vec<Twist> = parts.iter().flat_map(|p| p.iter().copied()).collect();
    if !achieves_zfa_pairwise(&joint) {
        return Coupling::Open;
    }
    if parts.iter().all(|p| is_pairwise_balanced(p)) {
        return Coupling::Independent;
    }
    if parts.iter().all(|p| folds_to_scalar(p)) {
        return Coupling::Product;
    }
    Coupling::Coupled
}

/// Which parts are *open* — neither count-balanced nor scalar-folding. These
/// are the peers that cannot be described on their own; they are what makes a
/// join `Coupled`.
pub fn open_parts(parts: &[&[Twist]]) -> Vec<usize> {
    parts
        .iter()
        .enumerate()
        .filter(|(_, p)| !is_pairwise_balanced(p) && !folds_to_scalar(p))
        .map(|(i, _)| i)
        .collect()
}

/// Classify a join given its parts as digit strings (`0`-`7`) separated by
/// `|`, and render the reading as JSON:
/// `{"verdict":"coupled","shared":true,"open":[0,1],"baseline":0.802893}`.
///
/// This is the whole body of the `wasm_coupling` binding, kept here rather
/// than in `wasm.rs` so it is compiled and tested on the native target too —
/// `wasm.rs` only builds under `--features wasm`.
pub fn coupling_json(parts: &str) -> String {
    let parsed: Vec<Vec<Twist>> = parts
        .split('|')
        .map(|p| {
            p.chars()
                .filter_map(|c| c.to_digit(8).and_then(|d| Twist::from_u8(d as u8)))
                .collect()
        })
        .collect();
    let refs: Vec<&[Twist]> = parsed.iter().map(|p| p.as_slice()).collect();
    let verdict = classify_parts(&refs);
    let open: Vec<String> = open_parts(&refs).iter().map(|i| i.to_string()).collect();
    format!(
        r#"{{"verdict":"{}","shared":{},"open":[{}],"baseline":{}}}"#,
        verdict.name(),
        verdict.is_shared_closure(),
        open.join(","),
        COUPLED_BASELINE
    )
}

/// The census baseline: of all shared closures cut from a balanced length-8
/// history, this fraction is coupled rather than product.
///
/// It is a measured constant, not a fit — and it is close to flat in length
/// (0.750, 0.791, 0.804, 0.803 at lengths 2, 4, 6, 8), so a room's own coupled
/// fraction is readable against it without picking a length. Source:
/// `factors` in `tests/data/census_inventory.json`.
pub const COUPLED_BASELINE: f64 = 0.802893;

#[cfg(test)]
mod tests {
    use super::*;
    use Twist::*;

    #[test]
    fn gauge_pair_is_product_axis_pair_is_coupled() {
        // The gauge pair survives into the product sector; the axis pair --
        // ER=EPR's primordial entanglement witness -- does not.
        assert_eq!(classify_join(&[Plus], &[Minus]), Coupling::Product);
        assert_eq!(classify_join(&[Up], &[Down]), Coupling::Coupled);
    }

    #[test]
    fn two_closed_peers_are_independent_not_shared() {
        let c = classify_join(&[Up, Down], &[Right, Left]);
        assert_eq!(c, Coupling::Independent);
        assert!(!c.is_shared_closure());
    }

    #[test]
    fn an_unbalanced_join_is_open() {
        assert_eq!(classify_join(&[Up], &[Right]), Coupling::Open);
    }

    #[test]
    fn open_parts_are_the_ones_that_couple() {
        // `^` is neither balanced nor scalar-folding; `v` likewise.
        assert_eq!(open_parts(&[&[Up], &[Down]]), vec![0, 1]);
        // The gauge pair is scalar-folding on both sides, so nothing is open.
        assert!(open_parts(&[&[Plus], &[Minus]]).is_empty());
    }

    #[test]
    fn three_peers_generalise_the_cut() {
        // Each peer closes alone.
        assert_eq!(
            classify_parts(&[&[Up, Down], &[Right, Left], &[Plus, Minus]]),
            Coupling::Independent
        );
        // One peer is open, so the room's closure is shared.
        assert_eq!(
            classify_parts(&[&[Up, Down], &[Right], &[Left]]),
            Coupling::Coupled
        );
    }

    #[test]
    fn coupling_json_is_what_the_browser_parses() {
        // `^` and `v` are twists 0 and 1; neither closes alone.
        assert_eq!(
            coupling_json("0|1"),
            r#"{"verdict":"coupled","shared":true,"open":[0,1],"baseline":0.802893}"#
        );
        // The gauge pair `+ -` is twists 6 and 7; both fold to a scalar.
        assert_eq!(
            coupling_json("6|7"),
            r#"{"verdict":"product","shared":true,"open":[],"baseline":0.802893}"#
        );
        // Two peers that each closed alone.
        assert_eq!(
            coupling_json("01|23"),
            r#"{"verdict":"independent","shared":false,"open":[],"baseline":0.802893}"#
        );
    }

    #[test]
    fn empty_room_closes_independently() {
        assert_eq!(classify_parts(&[]), Coupling::Independent);
    }
}
