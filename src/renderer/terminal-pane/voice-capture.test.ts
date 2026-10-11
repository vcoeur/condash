import { describe, expect, it } from 'vitest';
import { bytesToBase64, encodeWav, float32ToInt16, RECORD_SAMPLE_RATE } from './voice-capture';

describe('float32ToInt16', () => {
  it('scales full-scale values to the rails', () => {
    expect(Array.from(float32ToInt16(new Float32Array([0, 1, -1])))).toEqual([0, 32767, -32768]);
  });

  it('hard-clips out-of-range samples', () => {
    expect(Array.from(float32ToInt16(new Float32Array([2, -2])))).toEqual([32767, -32768]);
  });

  it('rounds mid-range values', () => {
    expect(float32ToInt16(new Float32Array([0.5]))[0]).toBe(16383);
  });
});

describe('encodeWav', () => {
  it('writes a complete 44-byte RIFF/WAVE PCM header', () => {
    const pcm = new Int16Array(4);
    const wav = encodeWav(pcm, RECORD_SAMPLE_RATE);
    const text = String.fromCharCode(...wav.subarray(0, 44));
    expect(text.startsWith('RIFF')).toBe(true);
    expect(text.slice(8, 12)).toBe('WAVE');
    expect(text.slice(12, 16)).toBe('fmt ');
    expect(text.slice(36, 40)).toBe('data');
    const view = new DataView(wav.buffer);
    expect(view.getUint32(4, true)).toBe(36 + pcm.length * 2); // riff size
    expect(view.getUint16(20, true)).toBe(1); // PCM format
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(RECORD_SAMPLE_RATE);
    expect(view.getUint32(28, true)).toBe(RECORD_SAMPLE_RATE * 2); // byte rate
    expect(view.getUint16(34, true)).toBe(16); // bits
    expect(view.getUint32(40, true)).toBe(pcm.length * 2); // data size
    expect(wav.length).toBe(44 + pcm.length * 2);
  });

  it('carries the samples little-endian after the header', () => {
    const pcm = Int16Array.from([-32768, -1, 0, 1, 32767]);
    const wav = encodeWav(pcm, 8000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44 + 0 * 2, true)).toBe(-32768);
    expect(view.getInt16(44 + 4 * 2, true)).toBe(32767);
  });

  it('produces empty audio for an empty clip', () => {
    expect(encodeWav(new Int16Array(0), RECORD_SAMPLE_RATE)).toHaveLength(44);
  });
});

describe('bytesToBase64', () => {
  it('matches the platform coder on known bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('handles multi-chunk arrays', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 7).fill(7);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('round-trips a WAV body', () => {
    const pcm = Int16Array.from([100, -100, 3000]);
    const wav = encodeWav(pcm, RECORD_SAMPLE_RATE);
    const back = Uint8Array.from(Buffer.from(bytesToBase64(wav), 'base64'));
    expect(Array.from(back)).toEqual(Array.from(wav));
  });
});
