import { describe, it } from 'vitest';
import { exerciseVoiceLifecycle, lifecycleScenarios } from './fixtures/voice-owner-lifecycle';

describe('real recorder/session/registry/main owner lifecycle with fake media and sockets', () => {
  for (const scenario of lifecycleScenarios) {
    it(scenario, () => exerciseVoiceLifecycle(scenario));
  }
});
