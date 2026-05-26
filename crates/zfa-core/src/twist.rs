/// The 8-twist alphabet from QLF: {^, v, <, >, /, \, +, -}
/// Split into 4 positive (spatial+gauge) and 4 negative (spatial+gauge).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Twist {
    Up     = 0,  // ^  pos spatial (y+)
    Down   = 1,  // v  neg spatial (y-)
    Right  = 2,  // >  pos spatial (x+)
    Left   = 3,  // <  neg spatial (x-)
    Slash  = 4,  // /  pos spatial (z+)
    BSlash = 5,  // \  neg spatial (z-)
    Plus   = 6,  // +  pos gauge
    Minus  = 7,  // -  neg gauge
}

impl Twist {
    pub fn is_positive(self) -> bool {
        matches!(self, Twist::Up | Twist::Right | Twist::Slash | Twist::Plus)
    }

    pub fn is_negative(self) -> bool {
        !self.is_positive()
    }

    pub fn is_spatial(self) -> bool {
        matches!(self, Twist::Up | Twist::Down | Twist::Right | Twist::Left | Twist::Slash | Twist::BSlash)
    }

    pub fn is_gauge(self) -> bool {
        matches!(self, Twist::Plus | Twist::Minus)
    }

    pub fn conjugate(self) -> Self {
        match self {
            Twist::Up     => Twist::Down,
            Twist::Down   => Twist::Up,
            Twist::Right  => Twist::Left,
            Twist::Left   => Twist::Right,
            Twist::Slash  => Twist::BSlash,
            Twist::BSlash => Twist::Slash,
            Twist::Plus   => Twist::Minus,
            Twist::Minus  => Twist::Plus,
        }
    }

    pub fn symbol(self) -> char {
        match self {
            Twist::Up     => '^',
            Twist::Down   => 'v',
            Twist::Right  => '>',
            Twist::Left   => '<',
            Twist::Slash  => '/',
            Twist::BSlash => '\\',
            Twist::Plus   => '+',
            Twist::Minus  => '-',
        }
    }

    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Twist::Up),
            1 => Some(Twist::Down),
            2 => Some(Twist::Right),
            3 => Some(Twist::Left),
            4 => Some(Twist::Slash),
            5 => Some(Twist::BSlash),
            6 => Some(Twist::Plus),
            7 => Some(Twist::Minus),
            _ => None,
        }
    }
}

impl std::fmt::Display for Twist {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.symbol())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conjugate_involution() {
        for v in 0u8..8 {
            let t = Twist::from_u8(v).unwrap();
            assert_eq!(t.conjugate().conjugate(), t);
        }
    }

    #[test]
    fn exactly_four_positive() {
        let pos = (0u8..8)
            .filter_map(Twist::from_u8)
            .filter(|t| t.is_positive())
            .count();
        assert_eq!(pos, 4);
    }

    #[test]
    fn exactly_two_gauge() {
        let gauge = (0u8..8)
            .filter_map(Twist::from_u8)
            .filter(|t| t.is_gauge())
            .count();
        assert_eq!(gauge, 2);
    }
}
