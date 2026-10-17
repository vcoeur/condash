import { ipcMain } from 'electron';
import { registerVoiceIpc } from '../../src/main/ipc/voice';
import { fixture } from './voice-clarity-edges';
export { fixture };

export function install() {
  for (const channel of [
    'voiceCredentialStatus',
    'voiceTranscribe',
    'voiceSpeak',
    'voiceStreamStart',
    'voiceStreamAudio',
    'voiceStreamStop',
    'voiceStreamCancel',
  ])
    ipcMain.removeHandler(channel);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    fixture.endpoints.push(url);
    if (url === 'https://openrouter.ai/api/v1/audio/speech') {
      fixture.speechRequests.push(JSON.parse(String(init?.body)));
      if (fixture.mode === 'failed')
        throw new Error('Synthetic provider failure synthetic-openrouter synthetic-legacy-secret');
      return new Response(new Uint8Array([1, 2]), { status: fixture.speechStatus });
    }
    if (url !== 'https://openrouter.ai/api/v1/audio/transcriptions')
      throw new Error('Unexpected provider endpoint (network forbidden)');
    const body = JSON.parse(String(init?.body));
    const wav = Buffer.from(body.input_audio.data, 'base64');
    const request = {
      url,
      model: body.model,
      rate: wav.readUInt32LE(24),
      samples: wav.readUInt32LE(40) / 2,
      hints: body.provider?.options?.mistral?.context_bias ?? [],
      aborted: false,
    };
    fixture.requests.push(request);
    init?.signal?.addEventListener('abort', () => {
      request.aborted = true;
    });
    if (fixture.mode === 'failed') throw new Error('Synthetic provider failure');
    if (fixture.mode === 'hold')
      await new Promise<void>((resolve) => fixture.releases.push(resolve));
    return new Response(
      JSON.stringify({
        text: fixture.finalizing ? 'Synthetic corrected final' : 'Synthetic live caption',
      }),
    );
  };
  registerVoiceIpc();
  const handlers = (
    ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => Promise<unknown>> }
  )._invokeHandlers;
  const stop = handlers.get('voiceStreamStop')!;
  ipcMain.removeHandler('voiceStreamStop');
  ipcMain.handle('voiceStreamStop', async (...args) => {
    fixture.finalizing = true;
    const result = await stop(...args);
    if (fixture.mode === 'unknown') throw new Error('Synthetic lost Stop reply');
    return result;
  });
  const start = handlers.get('voiceStreamStart')!;
  ipcMain.removeHandler('voiceStreamStart');
  ipcMain.handle('voiceStreamStart', async (...args) => {
    fixture.finalizing = false;
    return start(...args);
  });
  const status = handlers.get('voiceCredentialStatus')!;
  ipcMain.removeHandler('voiceCredentialStatus');
  ipcMain.handle('voiceCredentialStatus', (...args) => {
    fixture.statusReads++;
    return status(...args);
  });
}
