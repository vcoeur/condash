import { describe, expect, it } from 'vitest';
import { insertTranscript } from './insert';

function makeDeps(live: string[] = []) {
  const writes: { sid: string; data: string }[] = [];
  return {
    writes,
    deps: {
      isLive: (sid: string) => live.includes(sid),
      write: (sid: string, data: string) => writes.push({ sid, data }),
    },
  };
}

describe('insertTranscript', () => {
  it('writes the sanitised transcript through the injected terminal path', () => {
    const { deps, writes } = makeDeps(['t-1']);
    const result = insertTranscript('t-1', 'list the files', deps);
    expect(result).toEqual({ inserted: true, chars: 'list the files'.length });
    expect(writes).toEqual([{ sid: 't-1', data: 'list the files' }]);
  });

  it('no-ops on an empty transcript and says so', () => {
    const { deps, writes } = makeDeps(['t-1']);
    expect(insertTranscript('t-1', '  \n ', deps)).toEqual({
      inserted: false,
      reason: 'empty-transcript',
    });
    expect(writes).toEqual([]);
  });

  it('no-ops on an unknown or exited session and says so', () => {
    const { deps, writes } = makeDeps([]);
    expect(insertTranscript('t-9', 'hello', deps)).toEqual({
      inserted: false,
      reason: 'no-session',
    });
    expect(writes).toEqual([]);
  });

  it('never writes control characters even when text is inserted', () => {
    const { deps, writes } = makeDeps(['t-1']);
    insertTranscript('t-1', 'do\x03it\x1b[31mnow', deps);
    expect(writes[0]?.data).toBe('doitnow');
  });

  it('caps the written length', () => {
    const { deps, writes } = makeDeps(['t-1']);
    insertTranscript('t-1', 'y'.repeat(50), deps, 10);
    expect(writes[0]?.data).toHaveLength(10);
  });
});
