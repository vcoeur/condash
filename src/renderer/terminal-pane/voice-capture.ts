// Pure capture helpers for push-to-talk: PCM → 16-bit mono WAV, and base64
// for the typed IPC hop. No DOM/media APIs here — the recorder owns those —
// so the byte-level contract ships with unit tests.

/** The renderer records at 16 kHz mono: speech-quality, quarter the data of
 *  44.1 kHz, and small enough that a 30 s clip is ~1 MB of WAV. */
export const RECORD_SAMPLE_RATE = 16000;

/**
 * Convert interleaved float samples [-1, 1] to 16-bit signed PCM with
 * rounding and hard clipping at the rails.
 */
export function float32ToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Encode 16-bit mono PCM as a complete WAV file (44-byte RIFF header + data).
 * The container both providers accept as `input_audio` / multipart upload —
 * the reason the renderer records WAV instead of MediaRecorder's webm/opus
 * (webm is not in OpenRouter's documented format list).
 */
export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate: rate * mono * 2 bytes
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  let offset = 44;
  for (let i = 0; i < pcm.length; i++, offset += 2) view.setInt16(offset, pcm[i], true);
  return bytes;
}

/**
 * Base64 a byte array in chunks — the plain `btoa(String.fromCharCode(...))`
 * spread blows the argument limit well before a long clip does.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}
