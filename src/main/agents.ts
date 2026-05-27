/**
 * Agent resolution (main process only).
 *
 * Agents are a flat `{ id, label, command }` list under the top-level `agents`
 * key of the effective conception config (`condash.json` overlaying the
 * per-machine `settings.json`). Each is a terminal launcher: spawning one runs
 * `command` in a new tab. There is no per-agent file store and no secret store —
 * a command inherits the terminal's ambient environment.
 */
import type { Agent } from '../shared/types';
import { getEffectiveConceptionConfig } from './effective-config';

/**
 * List the conception's configured agents, skipping half-filled rows — an
 * entry with a blank `id` (no stable identity) or a blank `command` (nothing to
 * launch). Returned in config order so the user controls the spawn-dropdown
 * ordering directly.
 */
export async function listAgents(conceptionPath: string): Promise<Agent[]> {
  const config = await getEffectiveConceptionConfig(conceptionPath);
  return (config.agents ?? []).filter(
    (agent) => agent.id.trim() !== '' && agent.command.trim() !== '',
  );
}
