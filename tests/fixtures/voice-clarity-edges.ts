import { EventEmitter } from 'node:events';

export const fixture = {
  sid: '',
  mode: 'live' as 'live' | 'unknown' | 'failed',
  writes: [] as { sid: string; text: string }[],
  requests: [] as { url: string; model: string }[],
  sockets: 0,
  chunks: 0,
  statusReads: 0,
};

// Replace only terminal/provider edges; handlers, key resolution, adapter,
// stream selection and insertion decisions remain the production modules.
export function listTerminalSessions() {
  return [{ id: fixture.sid }];
}
export function writeTerminal(sid: string, text: string) {
  fixture.writes.push({ sid, text });
}
export function tabRecentText() {
  return 'Synthetic recent output';
}

export default class FakeSocket extends EventEmitter {
  constructor() {
    super();
    fixture.sockets++;
    setImmediate(() => this.emit('open'));
  }
  send(data: string | Buffer) {
    if (Buffer.isBuffer(data)) {
      fixture.chunks++;
      if (fixture.chunks === 1)
        this.emit(
          'message',
          Buffer.from(
            JSON.stringify({ type: 'transcription.text.delta', text: 'Synthetic live caption' }),
          ),
          false,
        );
    } else if (JSON.parse(data).type === 'input_audio.end') {
      this.emit(
        'message',
        Buffer.from(
          JSON.stringify({ type: 'transcription.done', text: 'Synthetic realtime final' }),
        ),
        false,
      );
    }
  }
  close() {}
  terminate() {}
}
