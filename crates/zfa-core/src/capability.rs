use crate::history::{achieves_zfa, spectral_gap};
use crate::twist::Twist;

/// A capability token: an unforgeable ZFA-balanced identity.
///
/// In QuantumOS, possessing a capability name IS proof of authorization
/// (Curry-Howard for capabilities). Tokens are ZFA-balanced by construction —
/// their spectral gap is always 0, mirroring rho_process_always_zfa.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Capability {
    /// The ZFA-balanced twist sequence encoding this capability.
    /// Always satisfies achieves_zfa(&self.twists).
    twists: Vec<Twist>,
    /// Human-readable label (not part of the security identity).
    label: String,
}

impl Capability {
    /// Generate a new capability from raw bytes (e.g., from getrandom).
    /// Maps each byte to a twist pair [pos, neg] to ensure ZFA balance.
    pub fn from_entropy(bytes: &[u8], label: impl Into<String>) -> Self {
        let mut twists = Vec::with_capacity(bytes.len() * 2);
        for &b in bytes {
            // Each byte contributes one pos and one neg twist.
            // Pos twist from high nibble, neg twist from low nibble.
            let pos_idx = (b >> 4) & 0x3;  // 0..3 → Up, Right, Slash, Plus
            let neg_idx = (b & 0x3) + 4;   // 4..7 → Down, Left, BSlash, Minus
            // Safety: indices 0..7 are all valid Twist variants
            let pos = Twist::from_u8(pos_idx).unwrap_or(Twist::Plus);
            let neg = Twist::from_u8(neg_idx).unwrap_or(Twist::Minus);
            twists.push(pos);
            twists.push(neg);
        }
        debug_assert!(achieves_zfa(&twists), "capability must be ZFA-balanced");
        Self { twists, label: label.into() }
    }

    /// Create a named root capability (for testing / bootstrap).
    /// Uses a fixed minimal ZFA string [+, -].
    pub fn root(label: impl Into<String>) -> Self {
        Self {
            twists: vec![Twist::Plus, Twist::Minus],
            label: label.into(),
        }
    }

    /// Derive a child capability by appending a ZFA-balanced extension.
    /// The child is unforgeable without the parent.
    pub fn derive(&self, extension: &[u8], label: impl Into<String>) -> Self {
        let child_entropy = Self::from_entropy(extension, "");
        let mut twists = self.twists.clone();
        twists.extend_from_slice(&child_entropy.twists);
        debug_assert!(achieves_zfa(&twists));
        Self { twists, label: label.into() }
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn twists(&self) -> &[Twist] {
        &self.twists
    }

    pub fn spectral_gap(&self) -> i64 {
        spectral_gap(&self.twists)
    }

    /// Capabilities are always ZFA-balanced. Verifiable at runtime.
    pub fn is_valid(&self) -> bool {
        achieves_zfa(&self.twists)
    }

    /// Encoded as hex string of twist bytes (for signaling / wire format).
    pub fn to_hex(&self) -> String {
        self.twists.iter().map(|t| format!("{:01x}", *t as u8)).collect()
    }
}

impl std::fmt::Display for Capability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "cap:{}:{}", self.label, self.to_hex())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_capability_valid() {
        let cap = Capability::root("kernel");
        assert!(cap.is_valid());
        assert_eq!(cap.spectral_gap(), 0);
    }

    #[test]
    fn entropy_capability_valid() {
        let bytes = [0xAB, 0xCD, 0xEF, 0x01, 0x23, 0x45, 0x67, 0x89];
        let cap = Capability::from_entropy(&bytes, "peer-id");
        assert!(cap.is_valid(), "capability from entropy must be ZFA-balanced");
        assert_eq!(cap.spectral_gap(), 0);
    }

    #[test]
    fn derived_capability_valid() {
        let root = Capability::root("root");
        let child = root.derive(&[0x12, 0x34, 0x56], "child");
        assert!(child.is_valid());
        assert_eq!(child.spectral_gap(), 0);
    }

    #[test]
    fn display_format() {
        let cap = Capability::root("test");
        let s = cap.to_string();
        assert!(s.starts_with("cap:test:"));
    }
}
