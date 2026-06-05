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

/// True iff `count_pos(h) == count_neg(h)` — the Hermitian-pair multiset
/// face of half-spin closure (the abelian shadow of `achieves_zfa`).
///
/// Each event is structurally a bra-ket pair; this predicate counts the
/// multiset, ignoring order. The non-abelian face is [`is_pauli_closed`].
pub fn is_count_balanced(h: &[Twist]) -> bool {
    count_pos(h) == count_neg(h)
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
/// Neither face implies the other in isolation: `σ_x σ_y σ_z = iI` is
/// Pauli-closed but count-imbalanced; `^ < v -` is count-balanced but
/// folds to σ_x. Both together are the unique characterisation of a
/// closed half-spin process.
///
/// Pauli closure is not a "second condition" enforced on top of count
/// balance — it IS the SU(2)-scalar-return reading of half-spin closure.
/// See HALF-SPIN-ZFA-EMBEDDING.md §3a (and §6 for why H ≅ SU(2) is the
/// forced algebra at all).
///
/// Mirrors `is_zfa` in the QLF Python core (`twist_core.py`).
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
}
