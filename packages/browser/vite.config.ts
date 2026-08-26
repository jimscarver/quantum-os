import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// The app derives every identity from SHA-256 via Web Crypto, which browsers
// expose only in a secure context. http://localhost is one; http://<lan-ip> is
// not — so a dev server reached from anywhere but this machine's loopback (a
// ChromeOS browser talking to the Linux VM, a phone on the same network) fails
// to start at all, with "Web Crypto is unavailable".
//
// basic-ssl generates a self-signed cert on first run and caches it outside the
// repo: no per-developer setup, no key committed, nothing to rotate.
//
// Chrome will still show its "not private" interstitial, and no SAN tinkering
// avoids it — the cert is signed by nobody the browser trusts, and matching the
// IP would need an iPAddress SAN, which this plugin cannot emit (it writes
// every name as dNSName, which Chrome ignores for an IP URL). Click through
// once per origin. What Web Crypto is gated on is a secure context, and
// bypassing the interstitial grants one; the app starts normally after that.
export default defineConfig({
  plugins: [basicSsl({ name: "quantum-os-dev" })],
  base: "/quantum-os/",   // GitHub Pages repo subpath
  build: {
    outDir: "dist",
    target: "es2022",
  },
  optimizeDeps: {
    exclude: ["@quantum-os/zfa-core"],  // WASM module — don't pre-bundle
  },
  server: {
    port: 5173,
    // Listen on every interface: the point of the cert is to be reachable from
    // somewhere that is not this machine's loopback.
    host: true,
  },
});
