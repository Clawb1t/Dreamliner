declare module "gifenc/dist/gifenc.esm.js" {
  export type GifPalette = number[][];

  export type GifEncoder = {
    writeFrame: (
      index: Uint8Array,
      width: number,
      height: number,
      opts?: { palette?: GifPalette; delay?: number },
    ) => void;
    finish: () => void;
    bytes: () => Uint8Array;
  };

  export function GIFEncoder(opts?: { initialCapacity?: number; auto?: boolean }): GifEncoder;
  export function quantize(data: Uint8ClampedArray, maxColors: number): GifPalette;
  export function applyPalette(data: Uint8ClampedArray, palette: GifPalette): Uint8Array;
}
