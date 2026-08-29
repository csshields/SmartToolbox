import type { TranscriptionSettings } from "./db";

// The device records raw PCM and sends only that plus the three facts needed to
// describe it. It cannot send a WAV, because a WAV header's first field is the
// length and hold-to-talk does not know the length when recording starts -
// patching it afterwards would mean seeking backwards in a stream the device is
// writing forwards. Prepending the header here is a dozen lines and deletes the
// whole problem. See docs/PLAN-voice-lookup.md.
const WAV_HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;

export function pcmToWav(pcm: Buffer, sampleRate: number, channels: number) {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const bytesPerSample = BITS_PER_SAMPLE / 8;

  header.write("RIFF", 0, "ascii");
  // Everything after this field: the 44-byte header minus the 8 bytes already
  // written, plus the audio.
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");

  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk length, 16 for uncompressed PCM.
  header.writeUInt16LE(1, 20); // 1 = PCM, no compression.
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // Byte rate.
  header.writeUInt16LE(channels * bytesPerSample, 32); // Block align.
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);

  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export type VoiceAudioBody = {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  durationMs: number;
};

// Ten seconds of 16 kHz 16-bit mono. The cap exists on the device as well - this
// is the second half of the same rule, because a malformed length field or a
// device sending faster than it should must not be able to allocate without
// bound on the Pi.
export const MAX_AUDIO_BYTES = 16_000 * 2 * 10;

// 300 ms. Below this it is a brush against the pad rather than a word, and
// Whisper on a fragment that short returns confident nonsense rather than
// nothing - which is worse, because it looks like an answer.
const MIN_AUDIO_BYTES = 16_000 * 2 * 0.3;

export function parseVoiceAudioBody(body: unknown): VoiceAudioBody {
  const value = body as {
    format?: unknown;
    sampleRate?: unknown;
    channels?: unknown;
    data?: unknown;
  };

  if (value.format !== "pcm_s16le") {
    throw new Error("format must be pcm_s16le");
  }

  const sampleRate = typeof value.sampleRate === "number" ? value.sampleRate : 0;
  const channels = typeof value.channels === "number" ? value.channels : 0;

  if (sampleRate <= 0 || channels <= 0) {
    throw new Error("sampleRate and channels are required");
  }

  if (typeof value.data !== "string" || value.data.length === 0) {
    throw new Error("data is required");
  }

  const pcm = Buffer.from(value.data, "base64");

  // Buffer.from silently drops anything it cannot decode rather than throwing,
  // so a truncated or corrupted line arrives here as a short buffer instead of
  // an error. Check the length rather than trusting the decode.
  if (pcm.length === 0) {
    throw new Error("data was not decodable base64");
  }

  if (pcm.length > MAX_AUDIO_BYTES) {
    throw new Error(`audio is ${pcm.length} bytes, over the ${MAX_AUDIO_BYTES} cap`);
  }

  if (pcm.length < MIN_AUDIO_BYTES) {
    throw new Error("recording was too short to transcribe");
  }

  return {
    pcm,
    sampleRate,
    channels,
    durationMs: Math.round((pcm.length / (sampleRate * channels * 2)) * 1000),
  };
}

// Measured against this NAS on 2026-08-29, not guessed: one second of audio
// takes ~9.3s warm, repeatably, and the very first call after the container has
// been idle blew straight through a 30s ceiling while the model loaded. So this
// is generous by design - the failure it prevents is giving up on a
// transcription that was going to arrive.
//
// The device waits longer than this on purpose (VOICE_TIMEOUT_MS in the
// firmware), so a timeout here comes back as an error the box can show rather
// than as silence the box has to guess about.
const TRANSCRIBE_TIMEOUT_MS = 90_000;

export type Transcription = {
  transcript: string;
  provider: TranscriptionSettings["provider"];
};

export async function transcribeAudio(
  wav: Buffer,
  settings: TranscriptionSettings,
): Promise<Transcription> {
  const form = new FormData();
  const file = new File([new Uint8Array(wav)], "recording.wav", { type: "audio/wav" });

  if (settings.provider === "openai") {
    if (!Bun.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured on this server.");
    }

    form.append("file", file);
    form.append("model", "whisper-1");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${Bun.env.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`OpenAI transcription returned HTTP ${response.status}.`);
    }

    const result = (await response.json()) as { text?: unknown };
    return {
      transcript: typeof result.text === "string" ? result.text.trim() : "",
      provider: "openai",
    };
  }

  // whisper-asr-webservice. The multipart field is audio_file and output=txt
  // returns the transcript as a bare string - both taken from the service's own
  // /openapi.json rather than assumed, because the field name differs from
  // OpenAI's and a wrong one returns 422 rather than anything diagnostic.
  form.append("audio_file", file);

  const base = settings.nasUrl.replace(/\/$/, "");
  const response = await fetch(`${base}/asr?task=transcribe&output=txt&encode=true`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`NAS Whisper returned HTTP ${response.status}.`);
  }

  return { transcript: (await response.text()).trim(), provider: "nas_whisper" };
}
