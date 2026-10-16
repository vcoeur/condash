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
    const model =
      init?.body instanceof FormData
        ? String(init.body.get('model'))
        : JSON.parse(String(init?.body)).model;
    fixture.requests.push({ url, model });
    if (fixture.mode === 'failed') throw new Error('Synthetic provider failure');
    if (url === 'https://api.mistral.ai/v1/audio/transcriptions')
      return new Response(JSON.stringify({ text: 'Synthetic corrected final' }));
    if (url === 'https://openrouter.ai/api/v1/chat/completions')
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'Synthetic batch final' } }] }),
      );
    throw new Error('Unexpected provider endpoint');
  };
  registerVoiceIpc();
  const handlers = (
    ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => Promise<unknown>> }
  )._invokeHandlers;
  const stop = handlers.get('voiceStreamStop')!;
  ipcMain.removeHandler('voiceStreamStop');
  ipcMain.handle('voiceStreamStop', async (...args) => {
    const result = await stop(...args);
    if (fixture.mode === 'unknown') throw new Error('Synthetic lost Stop reply');
    return result;
  });
  const status = handlers.get('voiceCredentialStatus')!;
  ipcMain.removeHandler('voiceCredentialStatus');
  ipcMain.handle('voiceCredentialStatus', (...args) => {
    fixture.statusReads++;
    return status(...args);
  });
}
