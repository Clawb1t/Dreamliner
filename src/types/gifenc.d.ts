declare module "gifenc/dist/gifenc.esm.js" {
  export type GifPalette = number[][];

  export type GifEncoder = {
    writeFrame: (
      index: Uint8Array,
      width: number,
      height: number,
      opts?: {
        palette?: GifPalette;
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

  export function GIFEncoder(opts?: { initialCapacity?: number; auto?: boolean }): GifEncoder;
  export function quantize(
    data: Uint8ClampedArray | Uint8Array,
    maxColors: number,
    opts?: { format?: "rgb565" | "rgb444" | "rgba4444"; oneBitAlpha?: boolean | number; clearAlpha?: boolean },
  ): GifPalette;
  export function applyPalette(data: Uint8ClampedArray, palette: GifPalette): Uint8Array;
}
