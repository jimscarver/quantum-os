// display.ts — which surface the screen picker opens on.
//
// `displaySurface` is only a hint about which pane Chrome opens: tabs, windows
// or whole screens. There is no API to preselect a particular monitor, so the
// most a picker can do is open where you were last time, which is usually where
// you are going. Shared by the recorder and the call's screen share, which are
// the same choice made twice.

const KEY = "qos-share-surface";
const VALID = ["monitor", "window", "browser"] as const;
type Surface = (typeof VALID)[number];

const isSurface = (s: unknown): s is Surface => VALID.includes(s as Surface);

/** The pane to open on: whatever you shared last, or a window. */
export function preferredSurface(): Surface {
  try {
    const s = localStorage.getItem(KEY);
    if (isSurface(s)) return s;
  } catch { /* storage can be unavailable; the default is fine */ }
  return "window";
}

/** Remember what was actually shared, which is what the picker should offer next. */
export function rememberSurface(track: MediaStreamTrack): void {
  try {
    const s = (track.getSettings?.() as { displaySurface?: string } | undefined)?.displaySurface;
    if (isSurface(s)) localStorage.setItem(KEY, s);
  } catch { /* not worth failing a recording over */ }
}
