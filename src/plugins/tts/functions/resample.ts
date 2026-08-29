import prism from "prism-media";

/**
 * Converts raw mono PCM at `sampleRate` (Piper's output format) into the 48kHz stereo
 * signed-16-bit PCM Discord's voice gateway expects (StreamType.Raw), via ffmpeg.
 */
export function resampleToDiscordPcm(raw: Buffer, sampleRate: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = new prism.FFmpeg({
      args: [
        "-analyzeduration",
        "0",
        "-loglevel",
        "0",
        "-f",
        "s16le",
        "-ar",
        String(sampleRate),
        "-ac",
        "1",
        "-i",
        "-",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
      ],
    });

    const chunks: Buffer[] = [];
    ffmpeg.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.once("end", () => resolve(Buffer.concat(chunks)));
    ffmpeg.once("error", reject);
    ffmpeg.end(raw);
  });
}
