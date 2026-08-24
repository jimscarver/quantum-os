use crate::pauli::is_pauli_closed;
use crate::twist::Twist;

/// A sequence of twist events — the fundamental QLF history type.
pub type History = Vec<Twist>;

/// Total positive twists (^, >, /, +).
pub fn count_pos(h: &[Twist]) -> i64 {
    h.iter().filter(|t| t.is_positive()).count() as i64
}

/// Total negative twists (v, <, \, -).
pub fn count_neg(h: &[Twist]) -> i64 {
    h.iter().filter(|t| t.is_negative()).count() as i64
}

/// True iff `count_pos(h) == count_neg(h)` — positives and negatives balance
/// **in aggregate**, without regard to which conjugate pair they came from.
///
/// This is strictly weaker than QLF's count balance
/// ([`is_pairwise_balanced`]), which requires each conjugate pair to balance
/// on its own. `^^<<` passes this and fails that. Read the two-predicate note
/// on [`achieves_zfa`] before using either.
pub fn is_count_balanced(h: &[Twist]) -> bool {
    count_pos(h) == count_neg(h)
}

/// The **signed action vector**: `(#^-#v, #>-#<, #/-#\, #+-#-)`.
///
/// ZFA is *Zero Free Action* — this vector vanishing. Mirrors
/// `calculate_action` in the QLF Python core (`twist_core.py`), component
/// order included.
pub fn signed_action(h: &[Twist]) -> (i64, i64, i64, i64) {
    let n = |t: Twist| h.iter().filter(|&&x| x == t).count() as i64;
    (
        n(Twist::Up) - n(Twist::Down),
        n(Twist::Right) - n(Twist::Left),
        n(Twist::Slash) - n(Twist::BSlash),
        n(Twist::Plus) - n(Twist::Minus),
    )
}

/// True iff the signed action vector vanishes: `#^=#v ∧ #>=#< ∧ #/=#\ ∧
/// #+=#-`. This is QLF's **count balance** — the hypothesis of the keystone
/// theorem `count_balanced_pauli_closed`, which proves it implies Pauli
/// closure for every history, cross-axis interleavings included.
///
/// The aggregate [`is_count_balanced`] does *not* imply Pauli closure: 61,440
/// histories of length 6 alone are counterexamples. Anything appealing to the
/// keystone must use this predicate.
pub fn is_pairwise_balanced(h: &[Twist]) -> bool {
    signed_action(h) == (0, 0, 0, 0)
}

/// QLF's ZFA, exactly: count balance in the pairwise sense, and Pauli closure.
/// Mirrors `is_zfa` in the QLF Python core (`twist_core.py`), minus its
/// separate minimum-length gate.
///
/// By the keystone the second conjunct is implied by the first; it is kept
/// because that is how the runtime predicate is written and stated, and
/// `tests/census_conformance.rs` re-derives the implication rather than
/// assuming it.
pub fn achieves_zfa_pairwise(h: &[Twist]) -> bool {
    is_pairwise_balanced(h) && is_pauli_closed(h)
}

/// Full ZFA = **half-spin closure**: a process whose execution returns a
/// spin-1/2 spinor to itself up to a global phase. The predicate is the
/// conjunction of the two algebraic faces of that closure:
///
///   1. **Pauli closure** — the ordered SU(2) product folds to a scalar in
///      {+I, -I, +iI, -iI}. This is the *non-abelian* face: the spinor
///      returns up to phase. Order-sensitive because Paulis anti-commute.
///   2. **Count balance** — `count_pos(h) == count_neg(h)`. This is the
///      *abelian* face: each twist is paired with its Hermitian conjugate,
///      i.e. the history has bra-ket structure.
///
/// Pauli closure is not a "second condition" enforced on top of count
/// balance — it IS the SU(2)-scalar-return reading of half-spin closure.
/// See HALF-SPIN-ZFA-EMBEDDING.md §3a (and §6 for why H ≅ SU(2) is the
/// forced algebra at all).
///
/// # This is not QLF's ZFA
///
/// The count-balance conjunct here is the **aggregate** one
/// ([`is_count_balanced`]), where QLF's is **pairwise**
/// ([`is_pairwise_balanced`]). The aggregate reading is strictly weaker, so
/// this predicate accepts histories QLF's `is_zfa` rejects — `^^<<` folds to
/// `+I` and has two positives against two negatives, but its signed action
/// vector is `(2, -2, 0, 0)`, which is not zero free action.
///
/// The difference is not cosmetic. The keystone theorem
/// `count_balanced_pauli_closed` — count balance implies Pauli closure — holds
/// for the pairwise predicate and fails for this one, so an argument that
/// leans on the keystone must call [`achieves_zfa_pairwise`] instead.
///
/// This predicate is what the deployed capability format validates against
/// (`Capability::from_entropy` produces aggregate-balanced tokens), so it is
/// kept as-is rather than tightened underneath live room links.
/// `tests/census_conformance.rs` pins the gap so it cannot widen unnoticed.
pub fn achieves_zfa(h: &[Twist]) -> bool {
    is_count_balanced(h) && is_pauli_closed(h)
}

/// Spectral gap: |count_pos - count_neg|.
/// Vanishes iff the history is ZFA-symmetric (on the critical line).
/// Mirrors spectral_gap_zero_iff_symmetric in QLF_Spectral.lean.
pub fn spectral_gap(h: &[Twist]) -> i64 {
    (count_pos(h) - count_neg(h)).abs()
}

/// True iff spectral_gap = 0, i.e., achieves_zfa.
pub fn is_symmetric(h: &[Twist]) -> bool {
    spectral_gap(h) == 0
}

/// Per-axis B-field components from spatial twists.
pub fn b_field(h: &[Twist]) -> (i64, i64, i64) {
    let bx = h.iter().filter(|&&t| t == Twist::Right).count() as i64
           - h.iter().filter(|&&t| t == Twist::Left).count() as i64;
    let by = h.iter().filter(|&&t| t == Twist::Up).count() as i64
           - h.iter().filter(|&&t| t == Twist::Down).count() as i64;
    let bz = h.iter().filter(|&&t| t == Twist::Slash).count() as i64
           - h.iter().filter(|&&t| t == Twist::BSlash).count() as i64;
    (bx, by, bz)
}

/// divB = Bx + By + Bz.
pub fn div_b(h: &[Twist]) -> i64 {
    let (bx, by, bz) = b_field(h);
    bx + by + bz
}

/// Net gauge imbalance (discrete charge density).
pub fn charge(h: &[Twist]) -> i64 {
    h.iter().filter(|&&t| t == Twist::Plus).count() as i64
  - h.iter().filter(|&&t| t == Twist::Minus).count() as i64
}

/// Gauss duality identity: for any achieves_zfa history, divB + charge = 0.
/// Panics in debug builds if violated.
pub fn assert_gauss_duality(h: &[Twist]) {
    debug_assert!(
        !achieves_zfa(h) || div_b(h) + charge(h) == 0,
        "Gauss duality violated: divB={} charge={} history={:?}",
        div_b(h), charge(h), h
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use Twist::*;

    #[test]
    fn empty_history_is_zfa() {
        assert!(achieves_zfa(&[]));
        assert_eq!(spectral_gap(&[]), 0);
    }

    #[test]
    fn balanced_pair_achieves_zfa() {
        let h = vec![Up, Down];
        assert!(achieves_zfa(&h));
        assert_eq!(spectral_gap(&h), 0);
    }

    #[test]
    fn unbalanced_does_not_achieve_zfa() {
        let h = vec![Up, Up, Down];
        assert!(!achieves_zfa(&h));
        assert_eq!(spectral_gap(&h), 1);
    }

    #[test]
    fn gauss_duality_holds() {
        // achieves_zfa history with nonzero B and charge
        let h = vec![Up, Down, Right, Left, Plus, Minus];
        assert!(achieves_zfa(&h));
        assert_eq!(div_b(&h) + charge(&h), 0);
    }

    #[test]
    fn gauss_duality_with_nonzero_charge() {
        // 3 pos (Up, Right, Plus) + 3 neg (Down, Left, Minus)
        let h = vec![Up, Down, Right, Slash, Plus, Minus, Left, BSlash];
        assert!(achieves_zfa(&h));
        let d = div_b(&h);
        let q = charge(&h);
        assert_eq!(d + q, 0, "divB={d} charge={q}");
    }

    #[test]
    fn no_magnetic_monopoles_for_neutral() {
        // charge-neutral achieves_zfa → divB = 0
        let h = vec![Up, Down, Right, Left, Slash, BSlash];
        assert!(achieves_zfa(&h));
        assert_eq!(charge(&h), 0);
        assert_eq!(div_b(&h), 0);
    }

    #[test]
    fn signed_action_is_the_qlf_vector() {
        // twist_core.calculate_action("^^<<") == (2, -2, 0, 0)
        let h = vec![Up, Up, Left, Left];
        assert_eq!(signed_action(&h), (2, -2, 0, 0));
    }

    #[test]
    fn aggregate_balance_is_strictly_weaker_than_pairwise() {
        // Two positives, two negatives, and the fold is +I — so this crate's
        // `achieves_zfa` accepts it. Its signed action vector is (2,-2,0,0),
        // so QLF's ZFA does not.
        let h = vec![Up, Up, Left, Left];
        assert!(is_count_balanced(&h));
        assert!(!is_pairwise_balanced(&h));
        assert!(achieves_zfa(&h));
        assert!(!achieves_zfa_pairwise(&h));
    }

    #[test]
    fn pairwise_balance_implies_the_aggregate() {
        for h in [
            vec![Up, Down],
            vec![Plus, Minus],
            vec![Up, Left, Down, Right],
            vec![Up, Down, Right, Left, Slash, BSlash],
        ] {
            assert!(is_pairwise_balanced(&h), "{h:?}");
            assert!(is_count_balanced(&h), "{h:?}");
            // The keystone: pairwise balance alone forces Pauli closure.
            assert!(achieves_zfa_pairwise(&h), "{h:?}");
        }
    }
}
