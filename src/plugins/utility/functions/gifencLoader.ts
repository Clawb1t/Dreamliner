type GifencExports = {
  quantize: (
    data: Uint8ClampedArray | Uint8Array,
    maxColors: number,
    opts?: { format?: "rgb565" | "rgb444" | "rgba4444"; oneBitAlpha?: boolean | number; clearAlpha?: boolean },
  ) => number[][];
  applyPalette: (data: Uint8ClampedArray, palette: number[][]) => Uint8Array;
  GIFEncoder: (opts?: { initialCapacity?: number; auto?: boolean }) => {
    writeFrame: (
      index: Uint8Array,
      width: number,
      height: number,
      opts?: {
        palette?: number[][];
        delay?: number;
        transparent?: boolean;
        transparentIndex?: number;
        dispose?: number;
        repeat?: number;
      },
    ) => void;
    finish: () => void;
    bytes: () => Uint8Array;
    /** The bytes written so far, without copying. */
    bytesView: () => Uint8Array;
  };
};

function resolveGifenc(mod: Record<string, unknown>): GifencExports {
  const fallback =
    mod.default && typeof mod.default === "object" ? (mod.default as Record<string, unknown>) : null;

  const quantize = (mod.quantize ?? fallback?.quantize) as GifencExports["quantize"];
  const applyPalette = (mod.applyPalette ?? fallback?.applyPalette) as GifencExports["applyPalette"];
  const GIFEncoder = (mod.GIFEncoder ?? fallback?.GIFEncoder) as GifencExports["GIFEncoder"];

  if (typeof quantize !== "function" || typeof applyPalette !== "function" || typeof GIFEncoder !== "function") {
    throw new Error("GIF encoder module is unavailable");
  }

  return { quantize, applyPalette, GIFEncoder };
}

let cached: GifencExports | null = null;

export async function loadGifenc(): Promise<GifencExports> {
  if (cached) return cached;
  const mod = await import("gifenc/dist/gifenc.esm.js");
  cached = resolveGifenc(mod as Record<string, unknown>);
  return cached;
}
