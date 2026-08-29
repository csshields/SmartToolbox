import { expect, test } from "bun:test";
import { MAX_AUDIO_BYTES, parseVoiceAudioBody, pcmToWav } from "./voice";

function silence(bytes: number) {
  return Buffer.alloc(bytes).toString("base64");
}

const validBody = (overrides: Record<string, unknown> = {}) => ({
  format: "pcm_s16le",
  sampleRate: 16000,
  channels: 1,
  data: silence(32_000), // One second.
  ...overrides,
});

test("pcmToWav writes a 44-byte header the sizes agree with", () => {
  const pcm = Buffer.alloc(3200);
  const wav = pcmToWav(pcm, 16000, 1);

  expect(wav.length).toBe(44 + pcm.length);
  expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
  expect(wav.subarray(36, 40).toString("ascii")).toBe("data");

  // The two length fields are the ones a decoder actually reads, and the whole
  // reason the Pi writes this header rather than the device.
  expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
  expect(wav.readUInt32LE(40)).toBe(pcm.length);
});

test("pcmToWav describes the format the device actually sends", () => {
  const wav = pcmToWav(Buffer.alloc(64), 16000, 1);

  expect(wav.readUInt16LE(20)).toBe(1); // PCM, uncompressed.
  expect(wav.readUInt16LE(22)).toBe(1); // Mono.
  expect(wav.readUInt32LE(24)).toBe(16000);
  expect(wav.readUInt32LE(28)).toBe(32000); // Byte rate: 16k * 1 * 2.
  expect(wav.readUInt16LE(32)).toBe(2); // Block align.
  expect(wav.readUInt16LE(34)).toBe(16);
});

test("parseVoiceAudioBody decodes base64 and reports the duration", () => {
  const audio = parseVoiceAudioBody(validBody());

  expect(audio.pcm.length).toBe(32_000);
  expect(audio.sampleRate).toBe(16000);
  expect(audio.durationMs).toBe(1000);
});

test("parseVoiceAudioBody rejects a format it cannot describe", () => {
  expect(() => parseVoiceAudioBody(validBody({ format: "mp3" }))).toThrow(/pcm_s16le/);
});

test("parseVoiceAudioBody rejects audio over the cap", () => {
  // The device caps recordings at ten seconds; this is the Pi refusing to be
  // told otherwise, because the cap is what bounds the allocation here.
  const body = validBody({ data: silence(MAX_AUDIO_BYTES + 2) });
  expect(() => parseVoiceAudioBody(body)).toThrow(/cap/);
});

test("parseVoiceAudioBody rejects a brush against the pad", () => {
  // 100ms. Whisper on a fragment this short returns confident nonsense, which
  // is worse than nothing because it looks like an answer.
  expect(() => parseVoiceAudioBody(validBody({ data: silence(3_200) }))).toThrow(/too short/);
});

test("parseVoiceAudioBody rejects data that is not base64 at all", () => {
  // Buffer.from drops undecodable input rather than throwing, so a corrupted
  // line arrives as a short buffer instead of an error. Length is the check.
  expect(() => parseVoiceAudioBody(validBody({ data: "!!!!" }))).toThrow();
});

test("parseVoiceAudioBody requires the fields that describe the samples", () => {
  expect(() => parseVoiceAudioBody(validBody({ sampleRate: 0 }))).toThrow(/sampleRate/);
  expect(() => parseVoiceAudioBody(validBody({ data: undefined }))).toThrow(/data/);
});
