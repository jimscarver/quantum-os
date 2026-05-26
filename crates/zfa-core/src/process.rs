use crate::history::{achieves_zfa, count_neg, count_pos};
use crate::twist::Twist;

/// A 2×2 Hermitian matrix in Pauli coordinates: t·I + x·σx + y·σy + z·σz.
/// Matches QLF's Form type in SpacetimeDynamics.lean.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Form {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Form {
    pub fn zero() -> Self {
        Self { t: 0.0, x: 0.0, y: 0.0, z: 0.0 }
    }

    pub fn identity() -> Self {
        Self { t: 1.0, x: 0.0, y: 0.0, z: 0.0 }
    }

    pub fn ket0() -> Self {
        // |0⟩⟨0| = ½(I + σz) → t=0.5, z=0.5
        Self { t: 0.5, x: 0.0, y: 0.0, z: 0.5 }
    }

    pub fn ket1() -> Self {
        // |1⟩⟨1| = ½(I - σz) → t=0.5, z=-0.5
        Self { t: 0.5, x: 0.0, y: 0.0, z: -0.5 }
    }

    /// The ZFA topo string for a Form: [pos, neg] for action, [neg, pos] for lift.
    pub fn action_topo() -> Vec<Twist> {
        vec![Twist::Plus, Twist::Minus]
    }

    pub fn lift_topo() -> Vec<Twist> {
        vec![Twist::Minus, Twist::Plus]
    }
}

/// RhoProcess: the QLF process algebra.
/// Every constructible process achieves ZFA by construction.
#[derive(Debug, Clone)]
pub enum Process {
    /// ket direction [+,-]: eval = Form matrix.
    Action(Form),
    /// bra direction [-,+]: eval = Form matrix† (= Form matrix, Hermitian).
    Lift(Form),
    /// Superposition: eval = p.eval + q.eval.
    Parallel(Box<Process>, Box<Process>),
    /// Composition: eval = p.eval * q.eval.
    Sequence(Box<Process>, Box<Process>),
    /// Adjoint: eval = (p.eval)†.
    Dagger(Box<Process>),
}

impl Process {
    /// The ZFA topo string of a process.
    /// Every process achieves ZFA — mirrors rho_process_always_zfa in RhoQuCalc.lean.
    pub fn topo(&self) -> Vec<Twist> {
        match self {
            Process::Action(_) => Form::action_topo(),
            Process::Lift(_)   => Form::lift_topo(),
            Process::Parallel(p, q) => {
                let mut h = p.topo();
                h.extend(q.topo());
                h
            }
            Process::Sequence(p, q) => {
                let mut h = p.topo();
                h.extend(q.topo());
                h
            }
            Process::Dagger(p) => p.topo().into_iter().map(|t| t.conjugate()).collect(),
        }
    }

    /// Every constructible process achieves ZFA. Verified at runtime in debug builds.
    pub fn zfa_check(&self) -> bool {
        achieves_zfa(&self.topo())
    }

    pub fn spectral_gap(&self) -> i64 {
        let h = self.topo();
        (count_pos(&h) - count_neg(&h)).abs()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_achieves_zfa() {
        let p = Process::Action(Form::ket0());
        assert!(p.zfa_check(), "action must achieve ZFA");
        assert_eq!(p.spectral_gap(), 0);
    }

    #[test]
    fn lift_achieves_zfa() {
        let p = Process::Lift(Form::ket1());
        assert!(p.zfa_check());
    }

    #[test]
    fn parallel_achieves_zfa() {
        let p = Process::Parallel(
            Box::new(Process::Action(Form::ket0())),
            Box::new(Process::Lift(Form::ket1())),
        );
        assert!(p.zfa_check(), "parallel must achieve ZFA (decoherence_impossibility)");
    }

    #[test]
    fn sequence_achieves_zfa() {
        let p = Process::Sequence(
            Box::new(Process::Action(Form::identity())),
            Box::new(Process::Lift(Form::identity())),
        );
        assert!(p.zfa_check());
    }

    #[test]
    fn dagger_achieves_zfa() {
        let p = Process::Dagger(Box::new(Process::Action(Form::ket0())));
        assert!(p.zfa_check());
    }
}
