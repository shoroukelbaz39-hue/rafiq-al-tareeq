import { describe, expect, it } from "vitest";
import { silentWavBytes } from "@/lib/keepalive";

describe("silentWavBytes", () => {
  it("builds a valid one-second silent WAV", () => {
    const b = silentWavBytes(1, 8000);
    expect(String.fromCharCode(...b.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...b.slice(8, 12))).toBe("WAVE");
    expect(b.length).toBe(44 + 8000);
    expect(new Set(b.slice(44))).toEqual(new Set([128]));
  });
});
