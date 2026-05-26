#!/usr/bin/env bash
# Setup script for quantum-os development environment.
set -e

echo "=== quantum-os setup ==="

# 1. Rust + wasm-pack
if ! command -v cargo &>/dev/null; then
  echo "[1/4] Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
else
  echo "[1/4] Rust already installed: $(cargo --version)"
fi

if ! command -v wasm-pack &>/dev/null; then
  echo "      Installing wasm-pack..."
  cargo install wasm-pack
else
  echo "      wasm-pack already installed: $(wasm-pack --version)"
fi

rustup target add wasm32-unknown-unknown

# 2. Node + pnpm
if ! command -v node &>/dev/null; then
  echo "[2/4] Installing Node via nvm..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  source "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm use 20
else
  echo "[2/4] Node already installed: $(node --version)"
fi

if ! command -v pnpm &>/dev/null; then
  echo "      Installing pnpm..."
  npm install -g pnpm
else
  echo "      pnpm already installed: $(pnpm --version)"
fi

# 3. Build WASM (must happen before pnpm install so @quantum-os/zfa-core resolves)
echo "[3/4] Building ZFA WASM kernel..."
pnpm build:wasm

# 4. JS dependencies
echo "[4/4] Installing JS dependencies..."
pnpm install

echo ""
echo "=== Setup complete ==="
echo ""
echo "Start the signaling server:  pnpm dev:signaling"
echo "Start the browser dev server: pnpm dev:browser"
echo "Run Rust tests:               pnpm test:rust"
