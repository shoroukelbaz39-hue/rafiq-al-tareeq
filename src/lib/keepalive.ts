// Best-effort "keep the trip alive when the phone is locked".
// A web page cannot track GPS in the background by itself: browsers pause it when the screen locks.
// What does help on Android Chrome is a page that is playing audio and has a media-session
// notification (like a music player): the browser keeps that tab alive. We loop one second of
// silence and register a media-session so the lock screen shows "رفيق الطريق: المتابعة شغالة".
// Not guaranteed on every phone, and it does not work on iPhone. The page also shows the time of
// the last GPS fix so the user can tell whether tracking is really alive.

let audioEl: HTMLAudioElement | null = null;
let url: string | null = null;

/** One second of 8 kHz mono 8-bit silence as a WAV blob URL. */
export function silentWavBytes(seconds = 1, rate = 8000): Uint8Array {
  const n = Math.round(seconds * rate);
  const buf = new Uint8Array(44 + n);
  const dv = new DataView(buf.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  str(0, "RIFF"); dv.setUint32(4, 36 + n, true); str(8, "WAVE"); str(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  str(36, "data"); dv.setUint32(40, n, true);
  buf.fill(128, 44); // 8-bit PCM silence is 128
  return buf;
}

export function keepAliveSupported(): boolean {
  return typeof window !== "undefined" && typeof Audio !== "undefined" && typeof URL !== "undefined" && "createObjectURL" in URL;
}

/** Must be called from a tap (browsers block audio otherwise). Returns true when the silent loop is playing. */
export async function startKeepAlive(destName: string, onStop?: () => void): Promise<boolean> {
  if (!keepAliveSupported()) return false;
  try {
    if (!audioEl) {
      url = URL.createObjectURL(new Blob([silentWavBytes().buffer as ArrayBuffer], { type: "audio/wav" }));
      audioEl = new Audio(url);
      audioEl.loop = true;
      audioEl.volume = 0.01;
    }
    await audioEl.play();
    const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession;
    if (ms && typeof MediaMetadata !== "undefined") {
      ms.metadata = new MediaMetadata({
        title: "المتابعة شغالة",
        artist: "رفيق الطريق، رايح " + destName,
        artwork: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      });
      ms.playbackState = "playing";
      try { ms.setActionHandler("pause", () => { stopKeepAlive(); onStop?.(); }); } catch { /* unsupported */ }
      try { ms.setActionHandler("stop", () => { stopKeepAlive(); onStop?.(); }); } catch { /* unsupported */ }
    }
    return true;
  } catch {
    audioEl = null;
    return false;
  }
}

export function stopKeepAlive(): void {
  try { audioEl?.pause(); } catch { /* ignore */ }
  audioEl = null;
  if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } url = null; }
  try {
    const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession;
    if (ms) { ms.playbackState = "none"; ms.metadata = null; }
  } catch { /* ignore */ }
}

export function keepAliveActive(): boolean {
  return audioEl != null && !audioEl.paused;
}
