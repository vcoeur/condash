import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knowledgeStrategy } from './index-knowledge';
import { projectsStrategy } from './index-projects';
import {
  enumerateIndexPaths,
  indexHumanContent,
  regenerateIndex,
  retainRecoveryIndexDirtyMarker,
  type IndexRecoveryLifecycle,
  type IndexRecoveryOutput,
  type IndexDirectoryEntry,
} from './index-tree';
import { withFileQueue } from './mutate-shared';
import { assertRecoveryRequirements, recoveryProtectedSpans } from './sync/index-recovery';

let conceptionDir: string;
let knowledgeDir: string;

describe('index merge ownership proof', () => {
  it('strips only strict unfenced drafted child rows, retaining prose, curation and ambiguous markers', () => {
    const drafted = '- [`child.md`](child.md) — *Draft.* `[tag]` <!-- draft -->';
    const retained =
      [
        '# Human index',
        'Intro <!-- draft -->',
        '- [`curated.md`](curated.md) — *Curated.* `[tag]`',
        '- [`external`](https://example.com) — *External.* <!-- draft -->',
        '- [`escape`](../elsewhere.md) — *Escaped.* <!-- draft -->',
        '- [`loose.md`](loose.md) malformed <!-- draft -->',
        '- [`interior.md`](interior.md) — *Interior.* <!-- draft --> annotation',
        '```md',
        drafted,
        '```',
      ].join('\r\n') + '\r\n';
    expect(indexHumanContent(drafted + '\r\n' + retained)).toBe(retained);
  });
  it.each([
    '- [`child.md`](child.md) — *Draft.* <!-- keep human annotation --> <!-- draft -->',
    '- [`child.md`](child.md) — *Draft.* `[tag]` <!-- first --> <!-- second --> <!-- draft -->',
    '- [`child.md`](child.md) — *Draft.* <!-- draft --> <!-- keep human annotation -->',
    '- [`child.md`](child.md) — *Draft <!-- keep body annotation --> text.* <!-- draft -->',
    '- [`child.md`](child.md) — *Draft.* <!-- draft --> <!-- draft -->',
    '- [`child.md`](child.md) — *Draft <!-- incomplete annotation.* <!-- draft -->',
  ])('retains ambiguous annotated row verbatim: %s', (row) => {
    expect(indexHumanContent(row + '\n')).toBe(row + '\n');
  });
});

beforeEach(async () => {
  conceptionDir = await mkdtemp(join(tmpdir(), 'condash-index-test-'));
  knowledgeDir = join(conceptionDir, 'knowledge');
  await fs.mkdir(knowledgeDir, { recursive: true });
});

afterEach(async () => {
  await rm(conceptionDir, { recursive: true, force: true });
});

async function writeFile(relPath: string, content: string): Promise<void> {
  const abs = join(conceptionDir, relPath);
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

async function readFile(relPath: string): Promise<string> {
  return fs.readFile(join(conceptionDir, relPath), 'utf8');
}

describe('optional recovery lifecycle', () => {
  function lifecycle(overrides: Partial<IndexRecoveryLifecycle> = {}): IndexRecoveryLifecycle {
    return {
      validateInput: async () => {},
      applyOutput: async ({ path, proposed, changed }) => {
        if (changed) await fs.writeFile(path, proposed);
      },
      applyMarker: async ({ path, proposed }) => {
        if (proposed !== null) await fs.writeFile(path, proposed);
        else
          await fs.unlink(path).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          });
      },
      ...overrides,
    };
  }

  function barrier(): { promise: Promise<void>; release(): void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  it('bounds a recovery output reread before parsing or allocating a growing whole-file payload', async () => {
    await fs.writeFile(join(knowledgeDir, 'index.md'), Buffer.alloc(8 * 1024 * 1024 + 1, 97));
    const applyOutput = vi.fn();
    await expect(
      regenerateIndex(conceptionDir, knowledgeStrategy, { recovery: lifecycle({ applyOutput }) }),
    ).rejects.toThrow('8 MiB supported bound');
    expect(applyOutput).not.toHaveBeenCalled();
  });

  it('enumerates the real walker outputs and skipped direct inputs without reading irrelevant payloads', async () => {
    await writeFile('knowledge/visible/deep/body.md', '# Body\n');
    await writeFile('knowledge/2026-07-12-reference/index.md', '# Skipped but read\n');
    for (const excluded of ['.hidden', 'node_modules', 'local', 'notes']) {
      await writeFile(`knowledge/${excluded}/index.md`, 'ignored');
    }
    await fs.symlink('/not/a/real/dependency', join(knowledgeDir, 'dependency'));
    const paths = await enumerateIndexPaths(conceptionDir, knowledgeStrategy);
    expect(paths.outputs.sort()).toEqual([
      'knowledge/index.md',
      'knowledge/visible/deep/index.md',
      'knowledge/visible/index.md',
    ]);
    expect(paths.inputs).toContain('knowledge/2026-07-12-reference/index.md');
    expect(paths.inputs).not.toContain('knowledge/dependency/index.md');
    const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
    expect(report.created.sort()).toEqual(paths.outputs);
  });

  it('includes broad project prevalidation paths and known absence, not just dated generation children', async () => {
    await writeFile('projects/strange/notes/README.md', '# Validated even in notes\n');
    await fs.mkdir(join(conceptionDir, 'projects', '2026-07', '2026-07-12-missing'), {
      recursive: true,
    });
    const paths = await enumerateIndexPaths(conceptionDir, projectsStrategy);
    expect(paths.inputs).toContain('projects/strange/notes/README.md');
    expect(paths.inputs).toContain('projects/2026-07/2026-07-12-missing/README.md');
    expect(paths.outputs).not.toContain('projects/2026-07/2026-07-12-missing/index.md');
    expect(paths.outputs).not.toContain('projects/strange/notes/index.md');
  });

  it('returns empty paths for a missing root and does not create it', async () => {
    expect(await enumerateIndexPaths(conceptionDir, projectsStrategy)).toEqual({
      outputs: [],
      inputs: [],
    });
    await expect(fs.stat(join(conceptionDir, 'projects'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('renders identical ordinary bytes and reports with the optional writer', async () => {
    await writeFile('knowledge/sub/body.md', '# Body\n\nLead.\n\n## Salientquartz\n');
    await writeFile('knowledge/.index-dirty', 'marker');
    const copy = join(conceptionDir, 'ordinary');
    await fs.cp(knowledgeDir, join(copy, 'knowledge'), { recursive: true });
    const ordinary = await regenerateIndex(copy, knowledgeStrategy);
    const guarded = await regenerateIndex(conceptionDir, knowledgeStrategy, {
      recovery: lifecycle(),
    });
    expect({ ...guarded, rootPath: '' }).toEqual({ ...ordinary, rootPath: '' });
    for (const path of ordinary.created) {
      expect(await fs.readFile(join(copy, path))).toEqual(
        await fs.readFile(join(conceptionDir, path)),
      );
    }
    expect(guarded.dirtyClear).toBe(true);
  });

  it('validates all current project README candidates before invoking real prevalidation, then repeats before drafting', async () => {
    const readme = 'projects/2026-07/2026-07-12-item/README.md';
    const extra = 'projects/non-month/notes/README.md';
    await writeFile(readme, '# Item\n');
    await writeFile(extra, '# Extra validation input\n');
    const validated: string[] = [];
    const strategy = {
      ...projectsStrategy,
      preValidation: vi.fn(async (root: string, conception: string) => {
        expect(validated).toContain(readme);
        expect(validated).toContain(extra);
        return projectsStrategy.preValidation!(root, conception);
      }),
      draftSubdirEntry: vi.fn(
        async (...args: Parameters<typeof projectsStrategy.draftSubdirEntry>) => {
          if (args[1].name === '2026-07-12-item') {
            expect(validated.filter((path) => path === readme).length).toBeGreaterThanOrEqual(2);
          }
          return projectsStrategy.draftSubdirEntry(...args);
        },
      ),
    };
    await regenerateIndex(conceptionDir, strategy, {
      recovery: lifecycle({
        validateInput: async ({ path, kind }) => {
          if (kind === 'readme') validated.push(relative(conceptionDir, path));
        },
      }),
    });
    expect(strategy.preValidation).toHaveBeenCalledOnce();
    expect(strategy.draftSubdirEntry).toHaveBeenCalled();
  });

  it('does not enter project prevalidation after an input validator refuses', async () => {
    await writeFile('projects/odd/notes/README.md', '# Input\n');
    const preValidation = vi.fn(projectsStrategy.preValidation!);
    await expect(
      regenerateIndex(
        conceptionDir,
        { ...projectsStrategy, preValidation },
        {
          recovery: lifecycle({
            validateInput: async ({ kind }) => {
              if (kind === 'readme') throw new Error('unsafe README');
            },
          }),
        },
      ),
    ).rejects.toThrow('unsafe README');
    expect(preValidation).not.toHaveBeenCalled();
    await expect(fs.stat(join(conceptionDir, 'projects/index.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('validates the freshly generated project month index before its parent reads it', async () => {
    await writeFile('projects/2026-07/2026-07-12-item/README.md', '# Item\n');
    const events: string[] = [];
    const strategy = {
      ...projectsStrategy,
      draftSubdirEntry: async (...args: Parameters<typeof projectsStrategy.draftSubdirEntry>) => {
        if (args[1].name === '2026-07') {
          expect(events.at(-1)).toBe('read:projects/2026-07/index.md');
          expect(events).toContain('completed:projects/2026-07/index.md');
          expect(await readFile('projects/2026-07/index.md')).toContain('2026-07-12-item');
        }
        return projectsStrategy.draftSubdirEntry(...args);
      },
    };
    await regenerateIndex(conceptionDir, strategy, {
      recovery: lifecycle({
        validateInput: async ({ path, kind }) => {
          if (kind === 'source') events.push(`read:${relative(conceptionDir, path)}`);
        },
        applyOutput: async (output) => {
          await lifecycle().applyOutput(output);
          events.push(`completed:${relative(conceptionDir, output.path)}`);
        },
      }),
    });
    expect(events).toContain('read:projects/2026-07/index.md');
  });

  it('allows the existing strategy to handle a validated absent dated-child index', async () => {
    await fs.mkdir(join(knowledgeDir, '2026-07-12-missing'));
    const inputs: string[] = [];
    await regenerateIndex(conceptionDir, knowledgeStrategy, {
      recovery: lifecycle({
        validateInput: async ({ path, kind }) => {
          if (kind === 'source') inputs.push(path);
        },
      }),
    });
    expect(inputs).toContain(join(knowledgeDir, '2026-07-12-missing/index.md'));
    expect(await readFile('knowledge/index.md')).toContain('2026-07-12-missing/index.md');
  });

  it('validates knowledge file and dated-child inputs immediately before actual strategy consumption', async () => {
    const dated = 'knowledge/2026-07-12-reference/index.md';
    await writeFile(dated, '# Reference\n\n## Salientquartz\n');
    await writeFile('knowledge/body.md', '# Body\n');
    const events: string[] = [];
    const strategy = {
      ...knowledgeStrategy,
      draftFileEntry: async (...args: Parameters<typeof knowledgeStrategy.draftFileEntry>) => {
        expect(events.at(-1)).toBe(args[1].absPath);
        return knowledgeStrategy.draftFileEntry(...args);
      },
      draftSubdirEntry: async (...args: Parameters<typeof knowledgeStrategy.draftSubdirEntry>) => {
        expect(events.at(-1)).toBe(join(args[1].absPath, 'index.md'));
        return knowledgeStrategy.draftSubdirEntry(...args);
      },
    };
    await regenerateIndex(conceptionDir, strategy, {
      recovery: lifecycle({
        validateInput: async ({ path }) => {
          events.push(path);
        },
      }),
    });
    expect(await readFile('knowledge/index.md')).toContain('salientquartz');
    expect(events).toContain(join(conceptionDir, dated));
  });

  it('rejects a skipped dated input before its strategy can read it or write the parent', async () => {
    await writeFile('knowledge/2026-07-12-reference/index.md', '# Reference\n');
    await writeFile('knowledge/index.md', '# Original\n');
    const draftSubdirEntry = vi.fn(knowledgeStrategy.draftSubdirEntry);
    await expect(
      regenerateIndex(
        conceptionDir,
        { ...knowledgeStrategy, draftSubdirEntry },
        {
          recovery: lifecycle({
            validateInput: async ({ path }) => {
              if (path.endsWith('/2026-07-12-reference/index.md'))
                throw new Error('unsafe skipped input');
            },
          }),
        },
      ),
    ).rejects.toThrow('unsafe skipped input');
    expect(draftSubdirEntry).not.toHaveBeenCalled();
    expect(await readFile('knowledge/index.md')).toBe('# Original\n');
  });

  it('validates newly discovered children rather than relying on a preflight path list', async () => {
    let introduced = false;
    const validated: string[] = [];
    await regenerateIndex(conceptionDir, knowledgeStrategy, {
      recovery: lifecycle({
        validateInput: async ({ path, kind }) => {
          if (kind === 'output' && !introduced) {
            introduced = true;
            await writeFile(
              'knowledge/2026-07-12-dynamic/index.md',
              '# Dynamic\n\n## Salientquartz\n',
            );
          }
          validated.push(path);
        },
      }),
    });
    // The first directory's children were already listed; the next invocation discovers it.
    await regenerateIndex(conceptionDir, knowledgeStrategy, {
      recovery: lifecycle({
        validateInput: async ({ path }) => {
          validated.push(path);
        },
      }),
    });
    expect(validated).toContain(join(knowledgeDir, '2026-07-12-dynamic/index.md'));
    expect(await readFile('knowledge/index.md')).toContain('salientquartz');
  });

  it('validates an actually dynamic child in the same run before reading its index', async () => {
    let directoryVisits = 0;
    const events: string[] = [];
    await regenerateIndex(conceptionDir, knowledgeStrategy, {
      recovery: lifecycle({
        validateInput: async ({ path, kind }) => {
          if (path === knowledgeDir && kind === 'directory' && ++directoryVisits === 3) {
            await writeFile(
              'knowledge/2026-07-12-dynamic/index.md',
              '# Dynamic\n\n## Salientquartz\n',
            );
          }
          events.push(path);
        },
      }),
    });
    expect(events).toContain(join(knowledgeDir, '2026-07-12-dynamic/index.md'));
    expect(await readFile('knowledge/index.md')).toContain('salientquartz');
  });

  it('delivers changed and unchanged results with exact render bytes and does not write unchanged indexes', async () => {
    await writeFile('knowledge/body.md', '# Body\n');
    const results: IndexRecoveryOutput[] = [];
    const recovery = lifecycle({
      applyOutput: async (output) => {
        results.push(output);
        if (output.changed) await fs.writeFile(output.path, output.proposed);
      },
    });
    await regenerateIndex(conceptionDir, knowledgeStrategy, { recovery });
    expect(results[0].input).toBeNull();
    expect(results[0].changed).toBe(true);
    const before = await fs.stat(join(knowledgeDir, 'index.md'), { bigint: true });
    const bytes = await fs.readFile(join(knowledgeDir, 'index.md'));
    await regenerateIndex(conceptionDir, knowledgeStrategy, { recovery });
    expect(results[1]).toMatchObject({
      input: bytes,
      proposed: bytes,
      changed: false,
      renames: [],
    });
    const after = await fs.stat(join(knowledgeDir, 'index.md'), { bigint: true });
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ino).toBe(before.ino);
  });

  it('delivers every suspected rename before allowing that output mutation', async () => {
    await writeFile(
      'knowledge/index.md',
      '# Knowledge\n\n- [`old-name.md`](old-name.md) — *Old.* <!-- draft -->\n',
    );
    await writeFile('knowledge/old-names.md', '# Similar new name\n');
    const before = await readFile('knowledge/index.md');
    await expect(
      regenerateIndex(conceptionDir, knowledgeStrategy, {
        recovery: lifecycle({
          applyOutput: async (output) => {
            expect(output.renames).toEqual([
              { indexPath: 'knowledge/index.md', oldName: 'old-name.md', newName: 'old-names.md' },
            ]);
            throw new Error('ambiguous rename');
          },
        }),
      }),
    ).rejects.toThrow('ambiguous rename');
    expect(await readFile('knowledge/index.md')).toBe(before);
  });

  it.each(['changed', 'unchanged'])(
    'runs %s validation through async completion inside one file queue',
    async (mode) => {
      await writeFile('knowledge/body.md', '# Body\n');
      if (mode === 'unchanged') await regenerateIndex(conceptionDir, knowledgeStrategy);
      const entered = barrier();
      const finish = barrier();
      const events: string[] = [];
      const running = regenerateIndex(conceptionDir, knowledgeStrategy, {
        recovery: lifecycle({
          applyOutput: async (output) => {
            expect(output.changed).toBe(mode === 'changed');
            events.push('guard');
            entered.release();
            await finish.promise;
            if (output.changed) await fs.writeFile(output.path, output.proposed);
            events.push('strict-completion');
          },
          applyMarker: async () => {
            events.push('marker');
          },
        }),
      });
      await entered.promise;
      const follower = withFileQueue(join(knowledgeDir, 'index.md'), async () => {
        events.push('next-writer');
      });
      expect(events).toEqual(['guard']);
      finish.release();
      await Promise.all([running, follower]);
      expect(events.indexOf('strict-completion')).toBeLessThan(events.indexOf('next-writer'));
      expect(events.indexOf('strict-completion')).toBeLessThan(events.indexOf('marker'));
    },
  );

  it('rechecks queued render input after an earlier queued writer runs', async () => {
    await writeFile('knowledge/index.md', '# Original\n');
    await writeFile('knowledge/body.md', '# Body\n');
    const releaseWriter = barrier();
    const writerEntered = barrier();
    const rendered = barrier();
    const writer = withFileQueue(join(knowledgeDir, 'index.md'), async () => {
      writerEntered.release();
      await releaseWriter.promise;
      await writeFile('knowledge/index.md', '# Later human edit\n');
    });
    await writerEntered.promise;
    const applyOutput = vi.fn(async () => {});
    const running = regenerateIndex(
      conceptionDir,
      {
        ...knowledgeStrategy,
        draftFileEntry: async (...args: Parameters<typeof knowledgeStrategy.draftFileEntry>) => {
          const draft = await knowledgeStrategy.draftFileEntry(...args);
          rendered.release();
          return draft;
        },
      },
      { recovery: lifecycle({ applyOutput }) },
    );
    const refused = expect(running).rejects.toThrow('Recovery render input changed');
    await rendered.promise;
    releaseWriter.release();
    await writer;
    await refused;
    expect(applyOutput).not.toHaveBeenCalled();
    expect(await readFile('knowledge/index.md')).toBe('# Later human edit\n');
  });

  it.each(['same-content', 'mode', 'replacement', 'symlink', 'hardlink', 'ancestor'])(
    'refuses observable %s drift before lifecycle writes',
    async (drift) => {
      await writeFile('knowledge/index.md', '# Original\n');
      await writeFile('knowledge/body.md', '# Body\n');
      const applyOutput = vi.fn(async () => {});
      const strategy = {
        ...knowledgeStrategy,
        draftFileEntry: async (...args: Parameters<typeof knowledgeStrategy.draftFileEntry>) => {
          const draft = await knowledgeStrategy.draftFileEntry(...args);
          const index = join(knowledgeDir, 'index.md');
          if (drift === 'same-content') await fs.utimes(index, new Date(0), new Date(0));
          if (drift === 'mode') await fs.chmod(index, 0o600);
          if (drift === 'replacement') {
            await writeFile('knowledge/replacement', '# Original\n');
            await fs.rename(join(knowledgeDir, 'replacement'), index);
          }
          if (drift === 'symlink') {
            await fs.unlink(index);
            await fs.symlink('body.md', index);
          }
          if (drift === 'hardlink') await fs.link(index, join(knowledgeDir, 'alias'));
          if (drift === 'ancestor') await fs.chmod(knowledgeDir, 0o700);
          return draft;
        },
      };
      await expect(
        regenerateIndex(conceptionDir, strategy, { recovery: lifecycle({ applyOutput }) }),
      ).rejects.toThrow(/Recovery render input changed|Unsafe recovery file/);
      expect(applyOutput).not.toHaveBeenCalled();
    },
  );

  it('stops generation and retains the marker after an asynchronous completion failure', async () => {
    await writeFile('knowledge/sub/body.md', '# Body\n');
    await writeFile('knowledge/.index-dirty', 'original marker');
    const applyMarker = vi.fn(async () => {});
    await expect(
      regenerateIndex(conceptionDir, knowledgeStrategy, {
        recovery: lifecycle({
          applyOutput: async ({ path, proposed }) => {
            await fs.writeFile(path, proposed);
            await Promise.resolve();
            throw new Error('strict parent fsync failed');
          },
          applyMarker,
        }),
      }),
    ).rejects.toThrow('strict parent fsync failed');
    expect(await readFile('knowledge/sub/index.md')).toContain('body.md');
    await expect(fs.stat(join(knowledgeDir, 'index.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(applyMarker).not.toHaveBeenCalled();
    expect(await readFile('knowledge/.index-dirty')).toBe('original marker');
  });

  it('does not fall back to ordinary output or marker writers when lifecycle callbacks reject', async () => {
    await writeFile('knowledge/index.md', '# Original\n');
    await writeFile('knowledge/body.md', '# Body\n');
    await writeFile('knowledge/.index-dirty', 'keep marker');
    await expect(
      regenerateIndex(conceptionDir, knowledgeStrategy, {
        recovery: lifecycle({
          applyOutput: async () => {
            throw new Error('guard refused');
          },
        }),
      }),
    ).rejects.toThrow('guard refused');
    expect(await readFile('knowledge/index.md')).toBe('# Original\n');
    expect(await readFile('knowledge/.index-dirty')).toBe('keep marker');
    await expect(
      regenerateIndex(conceptionDir, knowledgeStrategy, {
        recovery: lifecycle({
          applyMarker: async () => {
            throw new Error('marker intent failed');
          },
        }),
      }),
    ).rejects.toThrow('marker intent failed');
    expect(await readFile('knowledge/.index-dirty')).toBe('keep marker');
  });

  it('queues marker writes and clears, preserving bytes on retain and reporting absent clears', async () => {
    const events: (Buffer | null)[] = [];
    const recovery = lifecycle({
      applyMarker: async (marker) => {
        events.push(marker.proposed);
        await lifecycle().applyMarker(marker);
      },
    });
    await retainRecoveryIndexDirtyMarker(conceptionDir, 'knowledge', recovery);
    expect(await readFile('knowledge/.index-dirty')).toBe('');
    await writeFile('knowledge/.index-dirty', 'retained bytes');
    await retainRecoveryIndexDirtyMarker(conceptionDir, 'knowledge', recovery);
    expect(await readFile('knowledge/.index-dirty')).toBe('retained bytes');
    const cleared = await regenerateIndex(conceptionDir, knowledgeStrategy, { recovery });
    expect(cleared.dirtyClear).toBe(true);
    const absent = await regenerateIndex(conceptionDir, knowledgeStrategy, { recovery });
    expect(absent.dirtyClear).toBe(false);
    expect(events).toEqual([Buffer.alloc(0), Buffer.from('retained bytes'), null, null]);
  });

  it('awaits marker completion inside its queue and propagates retain failures', async () => {
    const entered = barrier();
    const finish = barrier();
    const events: string[] = [];
    const pending = retainRecoveryIndexDirtyMarker(
      conceptionDir,
      'knowledge',
      lifecycle({
        applyMarker: async () => {
          entered.release();
          await finish.promise;
          events.push('marker-completed');
        },
      }),
    );
    await entered.promise;
    const next = withFileQueue(join(knowledgeDir, '.index-dirty'), async () => {
      events.push('next');
    });
    expect(events).toEqual([]);
    finish.release();
    await Promise.all([pending, next]);
    expect(events).toEqual(['marker-completed', 'next']);
    await expect(
      retainRecoveryIndexDirtyMarker(
        conceptionDir,
        'knowledge',
        lifecycle({
          applyMarker: async () => {
            throw new Error('retain completion failed');
          },
        }),
      ),
    ).rejects.toThrow('retain completion failed');
    await expect(fs.stat(join(knowledgeDir, '.index-dirty'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each(['retain', 'clear'])(
    'propagates %s completion failure even after the marker effect actually happened',
    async (operation) => {
      await writeFile('knowledge/.index-dirty', 'previous marker');
      const recovery = lifecycle({
        applyMarker: async (marker) => {
          await lifecycle().applyMarker(marker);
          throw new Error('marker completion publication failed');
        },
      });
      const pending =
        operation === 'retain'
          ? retainRecoveryIndexDirtyMarker(conceptionDir, 'knowledge', recovery)
          : regenerateIndex(conceptionDir, knowledgeStrategy, { recovery });
      await expect(pending).rejects.toThrow('marker completion publication failed');
      if (operation === 'retain')
        expect(await readFile('knowledge/.index-dirty')).toBe('previous marker');
      else
        await expect(fs.stat(join(knowledgeDir, '.index-dirty'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
    },
  );

  it('rejects lifecycle dry-run before any validation or mutation callback', async () => {
    const validateInput = vi.fn(async () => {});
    await expect(
      regenerateIndex(conceptionDir, knowledgeStrategy, {
        dryRun: true,
        recovery: lifecycle({ validateInput }),
      }),
    ).rejects.toThrow('cannot run in dry-run');
    expect(validateInput).not.toHaveBeenCalled();
  });
});

describe('metadata-only prospective recovery envelope', () => {
  const directory = (name: string): IndexDirectoryEntry => ({ name, kind: 'directory' });
  const file = (name: string): IndexDirectoryEntry => ({ name, kind: 'file' });

  function reader(entries: Record<string, IndexDirectoryEntry[]>) {
    const read = vi.fn(async (path: string) => entries[relative(conceptionDir, path)] ?? null);
    return read;
  }

  it('uses the real exclusions and includes skipped dated-child inputs without traversing their payloads', async () => {
    const read = reader({
      knowledge: [
        directory('internal'),
        directory('2026-07-10-dated'),
        directory('node_modules'),
        directory('notes'),
        directory('local'),
        directory('.hidden'),
        file('index.md'),
        file('body.md'),
        file('image.bin'),
        { name: 'dependency-link', kind: 'other' },
      ],
      'knowledge/internal': [file('index.md'), file('inside.md'), directory('deeper')],
      'knowledge/internal/deeper': [],
    });
    const draft = vi.fn(async () => {
      throw new Error('Prospective census must never draft or read source bytes');
    });
    const result = await enumerateIndexPaths(
      conceptionDir,
      { ...knowledgeStrategy, draftFileEntry: draft, draftSubdirEntry: draft },
      undefined,
      read,
    );
    expect(result.outputs.sort()).toEqual([
      'knowledge/index.md',
      'knowledge/internal/deeper/index.md',
      'knowledge/internal/index.md',
    ]);
    expect(result.inputs).toEqual([
      'knowledge/2026-07-10-dated/index.md',
      'knowledge/body.md',
      'knowledge/internal/deeper/index.md',
      'knowledge/internal/index.md',
      'knowledge/internal/inside.md',
    ]);
    expect(
      read.mock.calls.every(
        ([path]) =>
          !/node_modules|\/notes|\/local|\.hidden|2026-07-10-dated|dependency-link/.test(
            relative(conceptionDir, path),
          ),
      ),
    ).toBe(true);
    expect(draft).not.toHaveBeenCalled();
  });

  it('shares project output and prevalidation input traversal even when the incoming root is absent on disk', async () => {
    const read = reader({
      projects: [directory('2026-07'), directory('node_modules'), directory('.hidden')],
      'projects/2026-07': [directory('2026-07-10-alpha'), file('index.md')],
      'projects/node_modules': [],
    });
    const preValidation = vi.fn(async () => {
      throw new Error('Do not execute prevalidation against a virtual tree');
    });
    const result = await enumerateIndexPaths(
      conceptionDir,
      { ...projectsStrategy, preValidation },
      undefined,
      read,
    );
    expect(result.outputs.sort()).toEqual(['projects/2026-07/index.md', 'projects/index.md']);
    expect(result.inputs).toEqual([
      'projects/2026-07/2026-07-10-alpha/README.md',
      'projects/2026-07/index.md',
    ]);
    expect(preValidation).not.toHaveBeenCalled();
    expect(read.mock.calls.some(([path]) => path.endsWith('2026-07-10-alpha'))).toBe(false);
    await expect(fs.stat(join(conceptionDir, 'projects'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not invent an output root absent from the pinned directory metadata', async () => {
    const read = reader({});
    expect(await enumerateIndexPaths(conceptionDir, knowledgeStrategy, undefined, read)).toEqual({
      outputs: [],
      inputs: [],
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each(['../escape', 'nested/name', '\0', '', '.'])(
    'refuses invalid prospective directory name %j before traversal',
    async (name) => {
      const read = reader({ knowledge: [directory(name)] });
      await expect(
        enumerateIndexPaths(conceptionDir, knowledgeStrategy, undefined, read),
      ).rejects.toThrow('Invalid prospective');
      expect(read).toHaveBeenCalledTimes(1);
    },
  );
});

describe('recovery traversal resource boundaries', () => {
  it('streams real directory entries and stops at incremental validation before accumulating the whole child list', async () => {
    for (let index = 0; index < 20; index++)
      await writeFile(`knowledge/body-${index}.md`, '# Body\n');
    const readdir = vi.spyOn(fs, 'readdir');
    const opendir = vi.spyOn(fs, 'opendir');
    const observed = new Set<string>();
    const recovery: IndexRecoveryLifecycle = {
      validateInput: async (input) => {
        if (input.kind === 'source') {
          observed.add(input.path);
          if (observed.size > 2) throw new Error('fixture incremental budget');
        }
      },
      applyOutput: async () => {
        throw new Error('No output during census');
      },
      applyMarker: async () => {
        throw new Error('No marker during census');
      },
    };
    try {
      await expect(enumerateIndexPaths(conceptionDir, knowledgeStrategy, recovery)).rejects.toThrow(
        'fixture incremental budget',
      );
      expect(observed.size).toBe(3);
      expect(opendir).toHaveBeenCalled();
      expect(readdir).not.toHaveBeenCalled();
    } finally {
      readdir.mockRestore();
      opendir.mockRestore();
    }
  });
});

describe('regenerateIndex (knowledge strategy)', () => {
  describe('drafted-leaf marker', () => {
    it('emits the <!-- draft --> marker on every newly-drafted leaf bullet', async () => {
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nCross-cutting subjects.\n\n## Current files\n',
      );
      await writeFile(
        'knowledge/topics/sandbox-testing.md',
        '# Sandbox testing\n\nHow to drive vcoeur apps from the sandbox.\n\n## Recipe\n\nCall `condash run`.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);

      const index = await readFile('knowledge/topics/index.md');
      expect(index).toMatch(
        /- \[`sandbox-testing\.md`\]\(sandbox-testing\.md\) — \*[^*]+\*\s+`\[[^\]]+\]` <!-- draft -->/,
      );
    });

    it('idempotent: running twice produces zero diff', async () => {
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nCross-cutting subjects.\n\n## Current files\n',
      );
      await writeFile(
        'knowledge/topics/sandbox-testing.md',
        '# Sandbox testing\n\nHow to drive vcoeur apps.\n\n## Recipe\n\nCall the binary.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/topics/index.md');
      const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/topics/index.md');

      expect(after1).toBe(after2);
      expect(report.updated).toEqual([]);
      expect(report.created).toEqual([]);
    });
  });

  describe('tag-quality filter on initial draft', () => {
    it('strips stop-words and content-free verbs from H2-derived tags', async () => {
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nCross-cutting subjects.\n\n## Current files\n',
      );
      await writeFile(
        'knowledge/topics/legal-privacy.md',
        // Headings that would slugify to junk: `the`, `summary`, `develop`,
        // `notes`, `2026-04`. Plus one good heading.
        '# Legal and privacy\n\nLegal pages and CNIL rules.\n\n## The summary\n\n## Develop\n\n## Notes\n\n## 2026-04\n\n## Caddy access log retention\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const index = await readFile('knowledge/topics/index.md');

      expect(index).not.toMatch(/\bthe\b/i);
      expect(index).not.toMatch(/\bsummary\b/i);
      expect(index).not.toMatch(/\bdevelop\b/i);
      expect(index).not.toMatch(/\b2026-04\b/);
      // Good heading survives, slug form is hyphenated.
      expect(index).toContain('caddy');
    });
  });

  describe('drafted file bullet re-derivation', () => {
    it('re-derives a drafted file bullet when the body changes (tags AND description)', async () => {
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nInitial description text.\n\n## First heading\n\nBody.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/topics/index.md');
      expect(after1).toContain('Initial description text');
      expect(after1).toContain('first');
      expect(after1).toContain('<!-- draft -->');

      // Change the body: a new lead paragraph AND a new heading. The drafted
      // file bullet must be re-rendered in full — new description and new
      // tags — with the marker retained.
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nChanged description text.\n\n## Second heading\n\nBody.\n',
      );
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/topics/index.md');

      expect(after2).toContain('Changed description text');
      expect(after2).not.toContain('Initial description text');
      expect(after2).toContain('second');
      expect(after2).not.toContain('first');
      expect(after2).toContain('<!-- draft -->');
      const row2 = report2.updated.find((u) => u.indexPath === 'knowledge/topics/index.md');
      expect(row2).toBeDefined();
      expect(row2!.tagsAdded.some((t) => t.entry === 'drafting.md')).toBe(true);
    });

    it('re-renders a drafted file bullet on a description-only body change', async () => {
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nOriginal lead paragraph.\n\n## Stable heading\n\nBody.\n',
      );
      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/topics/index.md');
      expect(after1).toContain('Original lead paragraph');

      // Only the lead paragraph changes; the heading (and therefore the tag
      // set) stays identical. The full-render semantics must still reach disk.
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nRewritten lead paragraph.\n\n## Stable heading\n\nBody.\n',
      );
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/topics/index.md');

      expect(after2).toContain('Rewritten lead paragraph');
      expect(after2).not.toContain('Original lead paragraph');
      const row2 = report2.updated.find((u) => u.indexPath === 'knowledge/topics/index.md');
      expect(row2).toBeDefined();
    });

    it('leaves a curated file bullet untouched even when the body changes', async () => {
      // Curated bullet (no marker) carrying junk tags that the filter now
      // rejects: the engine must NOT re-derive it — the marker is the whole
      // ownership signal.
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n## Current files\n\n- [`drafting.md`](drafting.md) — *Curated description.* `[data-, 66ms]`\n',
      );
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nCompletely new body.\n\n## New heading\n\nBody.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const index = await readFile('knowledge/topics/index.md');
      expect(index).toContain(
        '- [`drafting.md`](drafting.md) — *Curated description.* `[data-, 66ms]`',
      );
      expect(index).not.toContain('<!-- draft -->');
    });

    it('produces no churn when an unchanged drafted file bullet is regenerated', async () => {
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nStable description text.\n\n## Stable heading\n\nBody.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/topics/index.md');
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/topics/index.md');

      expect(after2).toBe(after1);
      expect(report2.updated).toEqual([]);
    });

    it('leaves a curated row carrying a trailing annotation untouched', async () => {
      // Curated rows (no marker) are the supported home for human
      // annotations: a `<!-- TBC -->` on a curated row must survive a regen
      // with a changed body — comment and description intact.
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n## Current files\n\n- [`drafting.md`](drafting.md) — *Curated description.* `[curated-tag]` <!-- TBC -->\n',
      );
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nCompletely new body.\n\n## New heading\n\nBody.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const index = await readFile('knowledge/topics/index.md');
      expect(index).toContain(
        '- [`drafting.md`](drafting.md) — *Curated description.* `[curated-tag]` <!-- TBC -->',
      );
      expect(index).not.toContain('<!-- draft -->');
    });

    it('drops a stray trailing comment when re-deriving a drafted row', async () => {
      // Drafted rows are auto-managed: a stray `<!-- TBC -->` before the
      // marker is dropped on re-derivation — the engine emits
      // `body + tag block + marker` and owns the whole line.
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n## Current files\n\n- [`drafting.md`](drafting.md) — *Old description.* `[old-tag]` <!-- TBC --> <!-- draft -->\n',
      );
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nNew description text.\n\n## New heading\n\nBody.\n',
      );

      const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/topics/index.md');
      expect(after1).toMatch(
        /- \[`drafting\.md`\]\(drafting\.md\) — \*New description text\.\* `\[[^\]]+\]` <!-- draft -->$/m,
      );
      expect(after1).not.toContain('<!-- TBC -->');
      expect((after1.match(/<!-- draft -->/g) ?? []).length).toBe(1);
      const row = report.updated.find((u) => u.indexPath === 'knowledge/topics/index.md');
      expect(row).toBeDefined();

      // Converges: re-rendering the dropped output changes nothing.
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/topics/index.md');
      expect(after2).toBe(after1);
      expect(report2.updated).toEqual([]);
    });

    it('never touches interior HTML comments inside a curated description', async () => {
      // Round-3 regression: interior `<!-- ... -->` runs inside a description
      // are description text. The end-anchored parse strips cannot match
      // them, so the curated row must survive byte-identical — no loose
      // repair, no marker added, no rewrite.
      const curatedLine =
        '- [`drafting.md`](drafting.md) — *text <!-- A --> <!-- B --> more text.* `[curated-tag]`';
      await writeFile(
        'knowledge/topics/index.md',
        `# Topics\n\nIntro.\n\n## Current files\n\n${curatedLine}\n`,
      );
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nCompletely new body.\n\n## New heading\n\nBody.\n',
      );

      const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const index = await readFile('knowledge/topics/index.md');
      expect(index).toContain(curatedLine);
      expect(index).not.toContain('<!-- draft -->');
      const row = report.updated.find((u) => u.indexPath === 'knowledge/topics/index.md');
      expect(row).toBeUndefined();
    });

    it('leaves a curated row with an interior comment AND a trailing annotation untouched', async () => {
      // Round-4 blocker: the parse-side strip must match ONLY the trailing
      // `<!-- TBC -->` — never cross the interior `<!-- A -->`'s `-->` to
      // reach it (the tempered dot stops at the first `-->`). The interior
      // comment stays description text and the row survives byte-identical:
      // no loose repair, no marker added.
      const curatedLine =
        '- [`drafting.md`](drafting.md) — *text <!-- A --> more text.* `[tag]` <!-- TBC -->';
      await writeFile(
        'knowledge/topics/index.md',
        `# Topics\n\nIntro.\n\n## Current files\n\n${curatedLine}\n`,
      );
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nCompletely new body.\n\n## New heading\n\nBody.\n',
      );

      const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const index = await readFile('knowledge/topics/index.md');
      expect(index).toContain(curatedLine);
      expect(index).not.toContain('<!-- draft -->');
      const row = report.updated.find((u) => u.indexPath === 'knowledge/topics/index.md');
      expect(row).toBeUndefined();
    });

    it('rolls a re-derived file bullet tag up to the parent subdir bullet on the same pass', async () => {
      await writeFile('knowledge/index.md', '# Knowledge\n\nRoot.\n\n## Structure\n');
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nBody.\n\n## Alpha heading\n\nText.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/index.md');
      expect(after1).toContain('alpha');

      // Change the file's heading: the corrected tag must reach the root's
      // topics/ bullet in the SAME pass (the file re-derivation mutates the
      // file bullet's tags before the parent aggregate is built).
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nBody.\n\n## Beta heading\n\nText.\n',
      );
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/index.md');
      expect(after2).toContain('beta');
      expect(after2).not.toContain('alpha');
      const row2 = report2.updated.find((u) => u.indexPath === 'knowledge/index.md');
      expect(row2).toBeDefined();
    });

    it('repairs a loose (malformed) file bullet via the re-derivation path', async () => {
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n## Current files\n\n- [`drafting.md`](drafting.md)\n',
      );
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nRepaired description.\n\n## Some heading\n\nBody.\n',
      );

      const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const index = await readFile('knowledge/topics/index.md');

      // The malformed line is rebuilt from a fresh draft with the marker.
      expect(index).toMatch(
        /- \[`drafting\.md`\]\(drafting\.md\) — \*Repaired description\.\* `\[[^\]]+\]` <!-- draft -->/,
      );
      expect(index).not.toContain('- [`drafting.md`](drafting.md)\n');
      const row = report.updated.find((u) => u.indexPath === 'knowledge/topics/index.md');
      expect(row).toBeDefined();
    });

    it('--rewrite-aggregated leaves a curated file bullet untouched', async () => {
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n## Current files\n\n- [`drafting.md`](drafting.md) — *Curated description.* `[curated-tag]`\n',
      );
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nCompletely new body.\n\n## New heading\n\nBody.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy, { rewriteAggregated: true });
      const index = await readFile('knowledge/topics/index.md');
      expect(index).toContain(
        '- [`drafting.md`](drafting.md) — *Curated description.* `[curated-tag]`',
      );
      expect(index).not.toContain('<!-- draft -->');
    });

    it('keeps draft ownership across body changes (three-run lifecycle)', async () => {
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nRun one description.\n\n## First heading\n\nBody.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/topics/index.md');
      expect(after1).toContain('Run one description');
      expect(after1).toMatch(/<!-- draft -->\s*$/m);

      // Run 2 with ANOTHER body change: the drafted row re-derives again
      // (the marker is at line end, so ownership is unambiguous).
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nRun two description.\n\n## Second heading\n\nBody.\n',
      );
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/topics/index.md');
      expect(after2).toContain('Run two description');
      expect(after2).toContain('second');
      expect(after2).not.toContain('first');
      expect((after2.match(/<!-- draft -->/g) ?? []).length).toBe(1);
      const row2 = report2.updated.find((u) => u.indexPath === 'knowledge/topics/index.md');
      expect(row2).toBeDefined();

      // Run 3 with no change: byte-identical, no churn.
      const report3 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after3 = await readFile('knowledge/topics/index.md');
      expect(after3).toBe(after2);
      expect(report3.updated).toEqual([]);
    });

    it('emits exactly one draft marker and stays stable on the canonical row', async () => {
      // The post-drop shape (`body + tag block + marker`): re-rendering it
      // must reproduce the identical line — no double marker, no churn.
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n## Current files\n\n- [`drafting.md`](drafting.md) — *Stable description.* `[stable, tag]` <!-- draft -->\n',
      );
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nStable description.\n\n## Stable tag\n\nBody.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/topics/index.md');
      expect((after1.match(/<!-- draft -->/g) ?? []).length).toBe(1);
      expect(after1).toMatch(/<!-- draft -->\s*$/m);

      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/topics/index.md');
      expect(after2).toBe(after1);
      expect(report2.updated).toEqual([]);
    });
  });

  describe('aggregation cap + curated/drafted distinction', () => {
    it('caps drafted subdir-bullet aggregation at 8 and surfaces the surplus', async () => {
      // Build a subtree under topics/ with 12 distinct legit tags spread
      // across 12 leaves (one tag each). When regenerating the root, the
      // drafted topics/ bullet must be capped at 8 with the rest in
      // overTagDropped.
      const tags = [
        'sandbox-testing',
        'caddy-access-log',
        'port-range-11111',
        'electron-builder',
        'pii-stripping',
        'condash',
        'playwright',
        'postgres-ports',
        'vite-config',
        'drizzle-kit',
        'github-pages',
        'tauri-action',
      ];
      await writeFile('knowledge/index.md', '# Knowledge\n\nRoot.\n\n## Structure\n');
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      for (const tag of tags) {
        // Each leaf has a single H2 heading whose slug = the tag (single
        // token), forcing exactly one mined keyword per file.
        const h2 = tag.replace(/-/g, ' ');
        await writeFile(
          `knowledge/topics/${tag}.md`,
          `# ${h2}\n\nIntro for ${tag}.\n\n## ${h2}\n\nBody.\n`,
        );
      }

      const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const rootIndex = await readFile('knowledge/index.md');

      // The topics/ bullet should be present and capped.
      const bulletMatch = rootIndex.match(/- \[`topics\/`\][^\n]+/);
      expect(bulletMatch).not.toBeNull();
      const bullet = bulletMatch![0];
      const tagBlock = bullet.match(/`\[([^\]]+)\]`/);
      expect(tagBlock).not.toBeNull();
      const written = tagBlock![1].split(',').map((s) => s.trim());
      expect(written.length).toBe(8);

      // Report surfaces the dropped surplus on the topics/ bullet.
      const drop = report.overTagDropped.find((o) => o.entry === 'topics/');
      expect(drop).toBeDefined();
      expect(drop!.dropped.length).toBe(tags.length - 8);
    });

    it('leaves curated subdir bullets (no marker) untouched even when descendants change', async () => {
      // Hand-curated bullet: no marker, exactly two tags.
      await writeFile(
        'knowledge/index.md',
        '# Knowledge\n\nRoot.\n\n## Structure\n\n- [`topics/`](topics/index.md) — *cross-cutting topics.* `[curated-tag-one, curated-tag-two]`\n',
      );
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/sandbox-testing.md',
        '# Sandbox testing\n\nDrive apps from the sandbox.\n\n## Recipe\n\nDoes things.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const rootIndex = await readFile('knowledge/index.md');
      // Curated bullet preserved verbatim — no marker introduced, no descendant tags merged.
      expect(rootIndex).toContain(
        '- [`topics/`](topics/index.md) — *cross-cutting topics.* `[curated-tag-one, curated-tag-two]`',
      );
      expect(rootIndex).not.toContain('sandbox-testing');
      expect(rootIndex).not.toContain('<!-- draft -->');
    });

    it('--rewrite-aggregated promotes curated bullets to drafted and re-derives tags', async () => {
      await writeFile(
        'knowledge/index.md',
        '# Knowledge\n\nRoot.\n\n## Structure\n\n- [`topics/`](topics/index.md) — *cross-cutting topics.* `[stale-tag]`\n',
      );
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/sandbox-testing.md',
        '# Sandbox testing\n\nDrive apps from the sandbox.\n\n## Caddy access log\n\nSomething.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy, { rewriteAggregated: true });
      const rootIndex = await readFile('knowledge/index.md');

      // Marker added, stale-tag removed, descendant tags surfaced.
      expect(rootIndex).toContain('<!-- draft -->');
      expect(rootIndex).not.toContain('stale-tag');
      expect(rootIndex).toMatch(/topics\/.*caddy/);
    });

    it('drafted subdir bullet tracked across runs gets re-derived (junk leaks are healed)', async () => {
      // Initial run drafts the topics/ bullet (no on-disk bullet → engine
      // creates one with the marker).
      await writeFile('knowledge/index.md', '# Knowledge\n\nRoot.\n\n## Structure\n');
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/sandbox-testing.md',
        '# Sandbox testing\n\nFirst.\n\n## Caddy access log\n\nBody.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/index.md');
      expect(after1).toContain('<!-- draft -->');

      // Add a second leaf with a junk tag at the source. Re-run: the junk
      // doesn't make it into the parent because the filter rejects it.
      await writeFile(
        'knowledge/topics/observability.md',
        '# Observability\n\nMetrics.\n\n## The summary\n\n## Caddy access log\n\nMore.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/index.md');
      expect(after2).not.toMatch(/\b(?:the|summary)\b/i);
    });

    it('drafted subdir row with a stray comment converges to canonical form', async () => {
      // Round-4 blocker: replaceTagsInBullet must drop the stray `<!-- TBC -->`
      // (marker first, then trailing comments one at a time) BEFORE replacing
      // the tag block, so the row converges to `body + new tag block + marker`
      // instead of embedding the comment mid-line forever.
      await writeFile(
        'knowledge/index.md',
        '# Knowledge\n\nRoot.\n\n## Structure\n\n- [`topics/`](topics/index.md) — *Intro.* `[alpha]` <!-- TBC --> <!-- draft -->\n',
      );
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/a-leaf.md',
        '# A leaf\n\nBody.\n\n## Beta heading\n\nText.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/index.md');
      expect(after1).toMatch(
        /- \[`topics\/`\]\(topics\/index\.md\) — \*Intro\.\* `\[[^\]]+\]` <!-- draft -->$/m,
      );
      expect(after1).not.toContain('<!-- TBC -->');
      expect(after1).toContain('beta');
      expect(after1).not.toContain('alpha');
      expect((after1.match(/<!-- draft -->/g) ?? []).length).toBe(1);

      // Second regenerate: byte-identical, no churn.
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/index.md');
      expect(after2).toBe(after1);
      expect(report2.updated).toEqual([]);
    });

    it('omits the tag block on a drafted subdir row whose aggregate is empty (write-side parity)', async () => {
      // Closing-pass finding: replaceTagsInBullet always emitted `` `[]` `` while
      // formatBullet omits the block for empty keywords — divergent canonical
      // forms and one-time churn. A date-named leaf aggregates to zero tags
      // (its filename fallback is filtered), so the subdir row must render
      // without any tag block and stay byte-stable.
      await writeFile(
        'knowledge/index.md',
        '# Knowledge\n\nRoot.\n\n## Structure\n\n- [`topics/`](topics/index.md) — *Intro.* `[old]` <!-- draft -->\n',
      );
      // The leaf bullet is pre-written so the engine never adds a bucket
      // heading (`## Current files`) to the subdir index: with no H2/H3 and no
      // code spans in the head, the empty-aggregate fallback
      // (`deriveSubdirKeywords`) must also yield nothing.
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n- [`2026-04.md`](2026-04.md) — *Dated leaf.* <!-- draft -->\n',
      );
      await writeFile('knowledge/topics/2026-04.md', '# Dated leaf\n\nBody.\n');

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/index.md');
      expect(after1).toMatch(
        /- \[`topics\/`\]\(topics\/index\.md\) — \*Intro\.\* <!-- draft -->$/m,
      );
      expect(after1).not.toContain('`[]`');

      // Second regenerate: byte-identical, no churn.
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/index.md');
      expect(after2).toBe(after1);
      expect(report2.updated).toEqual([]);
    });
  });

  describe('curated leaf bullet preserved', () => {
    it('does not touch curated leaf bullet (no marker) when re-running', async () => {
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n## Current files\n\n- [`sandbox-testing.md`](sandbox-testing.md) — *Curated description.* `[curated-a, curated-b]`\n',
      );
      await writeFile(
        'knowledge/topics/sandbox-testing.md',
        '# Sandbox testing\n\nNew body.\n\n## Some heading\n\nText.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const index = await readFile('knowledge/topics/index.md');
      expect(index).toContain(
        '- [`sandbox-testing.md`](sandbox-testing.md) — *Curated description.* `[curated-a, curated-b]`',
      );
    });

    it('matches a bullet that carries a trailing curated HTML comment (no duplicate)', async () => {
      // Repro for issue #83: a curated bullet ending in `<!-- TBC -->` was
      // not recognised by the parser, so a re-run drafted a duplicate entry.
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n## Current files\n\n- [`sandbox-testing.md`](sandbox-testing.md) — *Curated description.* `[curated-a]` <!-- TBC -->\n',
      );
      await writeFile(
        'knowledge/topics/sandbox-testing.md',
        '# Sandbox testing\n\nBody.\n\n## Recipe\n\nText.\n',
      );

      const report = await regenerateIndex(conceptionDir, knowledgeStrategy, { dryRun: true });
      // Dry-run must not surface `sandbox-testing.md` as `added` — the
      // existing entry matches in spite of the trailing HTML comment.
      const addedToTopics = report.updated
        .filter((u) => u.indexPath === 'knowledge/topics/index.md')
        .flatMap((u) => u.added);
      expect(addedToTopics).toEqual([]);

      // Real run: the curated bullet (with the trailing comment) is preserved
      // verbatim, no duplicate is introduced.
      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const index = await readFile('knowledge/topics/index.md');
      expect(index).toContain(
        '- [`sandbox-testing.md`](sandbox-testing.md) — *Curated description.* `[curated-a]` <!-- TBC -->',
      );
      // Only one bullet for this file.
      const occurrences = index.match(/sandbox-testing\.md/g) ?? [];
      // One in the link text, one in the URL → two on the single bullet line.
      expect(occurrences.length).toBe(2);
    });
  });

  describe('body bullets under the H1 (no `## heading`)', () => {
    it('writes a new body-file bullet into the prologue, not just reporting it as added', async () => {
      // Hand-authored shape: the existing body bullet lives directly under the
      // H1 intro, with no `## Current files` heading. A regression guard for the
      // renderIndex prologue-skip bug where the new bullet was counted in
      // `added[]` but never written (orphan persisted, file rewritten identically).
      await writeFile(
        'knowledge/topics/agents/index.md',
        '# Agents\n\nConventions for agent configuration.\n\n' +
          '- [`agent-source-layout.md`](agent-source-layout.md) — *Decided source shape.* `[agents-md, scopes]`\n',
      );
      await writeFile(
        'knowledge/topics/agents/agent-source-layout.md',
        '# Agent source layout\n\nThe decided source shape for agent config.\n',
      );
      await writeFile(
        'knowledge/topics/agents/agedum-virtual-fs-launch.md',
        '# agedum virtual-FS launch\n\nHow agedum runs an agent CLI in a managed context.\n',
      );

      const report = await regenerateIndex(conceptionDir, knowledgeStrategy);

      const index = await readFile('knowledge/topics/agents/index.md');
      // The new bullet must actually be on disk...
      expect(index).toMatch(/- \[`agedum-virtual-fs-launch\.md`\]\(agedum-virtual-fs-launch\.md\)/);
      // ...the curated prologue bullet must survive verbatim...
      expect(index).toContain(
        '- [`agent-source-layout.md`](agent-source-layout.md) — *Decided source shape.* `[agents-md, scopes]`',
      );
      // ...the H1 intro is preserved...
      expect(index).toContain('# Agents');
      expect(index).toContain('Conventions for agent configuration.');
      // ...and the report's `added` matches what was written.
      const row = report.updated.find((u) => u.indexPath.endsWith('topics/agents/index.md'));
      expect(row?.added).toContain('agedum-virtual-fs-launch.md');
    });

    it('idempotent: a second run over a prologue-bullet index produces zero diff', async () => {
      await writeFile(
        'knowledge/topics/agents/index.md',
        '# Agents\n\nConventions for agent configuration.\n\n' +
          '- [`agent-source-layout.md`](agent-source-layout.md) — *Decided source shape.* `[agents-md, scopes]`\n',
      );
      await writeFile(
        'knowledge/topics/agents/agent-source-layout.md',
        '# Agent source layout\n\nThe decided source shape.\n',
      );
      await writeFile(
        'knowledge/topics/agents/agedum-virtual-fs-launch.md',
        '# agedum virtual-FS launch\n\nHow agedum runs an agent CLI.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const first = await readFile('knowledge/topics/agents/index.md');
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const second = await readFile('knowledge/topics/agents/index.md');
      expect(second).toBe(first);
      const row = report2.updated.find((u) => u.indexPath.endsWith('topics/agents/index.md'));
      expect(row).toBeUndefined();
    });
  });
});

describe('hand-written non-child bullets pass through verbatim', () => {
  it('preserves URL / cross-tree bullets byte-identically across a rewriting regen', async () => {
    const urlBullet = '- [Condash docs](https://condash.vcoeur.com) — public site.';
    const deepBullet = '- [Deep ref](../other/dir/file.md) — *cross-tree pointer.*';
    await writeFile(
      'knowledge/topics/index.md',
      [
        '# Topics',
        '',
        'Intro.',
        '',
        '## Current files',
        '',
        '- [`a-file.md`](a-file.md) — *Curated.* `[x]`',
        '',
        '## External links',
        '',
        urlBullet,
        deepBullet,
        '',
      ].join('\n'),
    );
    await writeFile('knowledge/topics/a-file.md', '# A\n\nBody A.\n');
    // A new on-disk child forces a real rewrite of the index.
    await writeFile('knowledge/topics/b-file.md', '# B\n\nBody B.\n');

    const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
    const index = await readFile('knowledge/topics/index.md');

    // The hand-written bullets survive byte-identically...
    expect(index).toContain(urlBullet);
    expect(index).toContain(deepBullet);
    // ...are never reported dropped...
    const row = report.updated.find((u) => u.indexPath.endsWith('topics/index.md'));
    expect(row?.dropped ?? []).toEqual([]);
    // ...and the new child still got drafted.
    expect(index).toMatch(/- \[`b-file\.md`\]\(b-file\.md\)/);
    // The new bullet must not land in the hand-written links section.
    expect(index.indexOf('- [`b-file.md`]')).toBeLessThan(index.indexOf('## External links'));

    // Second run: full idempotence, byte-identical.
    const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
    const index2 = await readFile('knowledge/topics/index.md');
    expect(index2).toBe(index);
    expect(report2.updated).toEqual([]);
  });
});

describe('fenced code blocks in hand-written prose are not structure', () => {
  it('leaves fenced engine-looking lines untouched and never parses them as headings or bullets', async () => {
    const fenceBlock = [
      '```sh',
      '## Current files',
      '',
      '- [`fake.md`](fake.md) — *Curated.* `[x]`',
      '- [`gone-dir/`](gone-dir/index.md) — *Curated.* `[y]`',
      '```',
    ].join('\n');
    await writeFile(
      'knowledge/topics/index.md',
      [
        '# Topics',
        '',
        'Intro.',
        '',
        '## Current files',
        '',
        '- [`a-file.md`](a-file.md) — *Curated.* `[a]`',
        '',
        fenceBlock,
        '',
      ].join('\n'),
    );
    await writeFile('knowledge/topics/a-file.md', '# A\n\nBody A.\n');
    // `fake.md` does NOT exist on disk — if the fenced bullet were parsed as
    // an engine-owned entry it would be dropped as stale; `gone-dir/` would
    // be dropped too; the fenced `##` line would split a phantom section.
    await regenerateIndex(conceptionDir, knowledgeStrategy);

    const index = await readFile('knowledge/topics/index.md');
    expect(index).toContain(fenceBlock);
    expect(index).toContain('- [`fake.md`](fake.md)');
    expect(index).toContain('- [`gone-dir/`](gone-dir/index.md)');
    // No phantom section was split off, and the fenced heading line survived
    // verbatim inside the fence.
    expect(index.match(/^## .+$/gm)).toEqual(['## Current files', '## Current files']);

    // Second run: byte-identical convergence.
    const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
    expect(await readFile('knowledge/topics/index.md')).toBe(index);
    expect(report2.updated).toEqual([]);
  });

  it('keeps a fence that directly abuts the block region prose-verbatim and drafts its child outside the fence', async () => {
    // Counterexample shape (acceptance15 run-RLvFse): the fence directly
    // abuts the surrounding content with no separating blank line and no
    // unfenced bullet before it, so the old fence-blind scan started the
    // bullet block inside the fence, dropped the fenced row and spliced the
    // engine's replacement row into the fence.
    const fenceBlock = [
      '~~~md',
      '- [`body.md`](body.md) — *Fenced row.* <!-- draft -->',
      '~~~',
    ].join('\n');
    await writeFile(
      'knowledge/index.md',
      [
        '# Knowledge',
        '',
        'Prose above the fence.',
        fenceBlock,
        '- [`a-file.md`](a-file.md) — *Curated.* `[a]`',
        '',
      ].join('\n'),
    );
    await writeFile('knowledge/body.md', '# Body\n\nSecond source.\n');
    await writeFile('knowledge/a-file.md', '# A\n\nBody A.\n');

    const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
    const index = await readFile('knowledge/index.md');

    // The fenced drafted row survives verbatim — prose, never engine-owned.
    expect(index).toContain(fenceBlock);
    expect(index).toContain('*Fenced row.*');
    // The canonical entry still comes from the disk child, drafted once,
    // after the kept bullet and outside the fence.
    const canonical = '- [`body.md`](body.md) — *Second source.* `[body]` <!-- draft -->';
    expect(index).toContain(canonical);
    expect(index.indexOf(canonical)).toBeGreaterThan(index.indexOf(fenceBlock));
    expect(index.split(canonical).length - 1).toBe(1);
    expect(index).toContain('- [`a-file.md`](a-file.md) — *Curated.* `[a]`');
    // The fenced row is prose: never reported dropped, never re-rendered.
    const row = report.updated.find((u) => u.indexPath === 'knowledge/index.md');
    expect(row?.dropped ?? []).toEqual([]);

    // Second run: byte-identical convergence.
    const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
    expect(await readFile('knowledge/index.md')).toBe(index);
    expect(report2.updated).toEqual([]);
  });

  it('appends additions before a fence that directly abuts the end of the bullet block', async () => {
    const fenceBlock = [
      '~~~md',
      '- [`body.md`](body.md) — *Fenced row.* <!-- draft -->',
      '~~~',
    ].join('\n');
    await writeFile(
      'knowledge/index.md',
      [
        '# Knowledge',
        '',
        'Prose.',
        '',
        '## Current files',
        '',
        '- [`a-file.md`](a-file.md) — *Curated.* `[a]`',
        fenceBlock,
        '',
      ].join('\n'),
    );
    await writeFile('knowledge/body.md', '# Body\n\nSecond source.\n');
    await writeFile('knowledge/a-file.md', '# A\n\nBody A.\n');

    await regenerateIndex(conceptionDir, knowledgeStrategy);
    const index = await readFile('knowledge/index.md');

    expect(index).toContain(fenceBlock);
    expect(index).toContain('*Fenced row.*');
    const canonical = '- [`body.md`](body.md) — *Second source.* `[body]` <!-- draft -->';
    expect(index).toContain(canonical);
    // The addition joins the kept bullets; the fence stays after them.
    expect(index.indexOf(canonical)).toBeGreaterThan(index.indexOf('- [`a-file.md`]'));
    expect(index.indexOf(canonical)).toBeLessThan(index.indexOf(fenceBlock));

    const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
    expect(await readFile('knowledge/index.md')).toBe(index);
    expect(report2.updated).toEqual([]);
  });

  it('never resurrects a fenced copy of a live drafted row as a canonical duplicate', async () => {
    // The fence stays prose; the canonical entry still comes from
    // shape.bullets only. The old scan treated the fenced copy as the block,
    // replaced it with the canonical row inside the fence and left the real
    // row below — a duplicate.
    const fenceBlock = [
      '~~~md',
      '- [`a-file.md`](a-file.md) — *Fenced copy of the live row.* <!-- draft -->',
      '~~~',
    ].join('\n');
    const live = '- [`a-file.md`](a-file.md) — *Body A.* `[a-file]` <!-- draft -->';
    await writeFile(
      'knowledge/index.md',
      ['# Knowledge', '', 'Prose.', fenceBlock, live, ''].join('\n'),
    );
    await writeFile('knowledge/a-file.md', '# A\n\nBody A.\n');

    const before = await readFile('knowledge/index.md');
    await regenerateIndex(conceptionDir, knowledgeStrategy);
    const index = await readFile('knowledge/index.md');

    expect(index).toBe(before);
    expect(index).toContain(fenceBlock);
    expect(index.split(live).length - 1).toBe(1);
  });
});

describe('stale dir-like bullet convergence', () => {
  it('drops a stale subdir bullet whose name lacks the trailing slash, and converges on run 2', async () => {
    // The bullet spells the dir `gone-dir` while the map keys the canonical
    // `gone-dir/` — the old delete-by-raw-name missed it, so the line was
    // never removed and every regen re-reported the same drop.
    await writeFile(
      'knowledge/index.md',
      [
        '# Knowledge',
        '',
        'Root.',
        '',
        '## Structure',
        '',
        '- [`topics/`](topics/index.md) — *Curated.* `[a]`',
        '- [`gone-dir`](gone-dir/index.md) — *Stale: the folder is gone.* `[b]`',
        '',
      ].join('\n'),
    );
    await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');

    const report1 = await regenerateIndex(conceptionDir, knowledgeStrategy);
    const after1 = await readFile('knowledge/index.md');
    const row1 = report1.updated.find((u) => u.indexPath === 'knowledge/index.md');
    expect(row1?.dropped).toEqual(['gone-dir']);
    expect(after1).not.toContain('gone-dir');
    expect(after1).toContain('- [`topics/`](topics/index.md) — *Curated.* `[a]`');

    // Run 2 must be a no-op: nothing dropped, nothing rewritten.
    const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
    const after2 = await readFile('knowledge/index.md');
    expect(after2).toBe(after1);
    expect(report2.updated).toEqual([]);
    expect(report2.unchanged).toContain('knowledge/index.md');
  });
});

describe('loose-row ownership amendment (user-approved 2026-11-18)', () => {
  const looseRow = '- [loose](loose.md) — Loose row';

  it('preserves a non-draft loose row with no real target verbatim across a real rewrite, and recovery protection agrees', async () => {
    // The round-2 acceptance counterexample: the loose row directly abuts
    // the bullet block, loose.md does not exist, and a new child forces a
    // real rewrite. Human owns the row — byte-identical, never dropped.
    const before = [
      '# Knowledge',
      '',
      'Prose.',
      '',
      '## Structure',
      '',
      '- [`a-file.md`](a-file.md) — *Curated.* `[a]`',
      looseRow,
      '',
    ].join('\n');
    await writeFile('knowledge/index.md', before);
    await writeFile('knowledge/a-file.md', '# A\n\nBody A.\n');
    await writeFile('knowledge/new.md', '# New\n\nNew source.\n');

    const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
    const index = await readFile('knowledge/index.md');

    expect(index).toContain(looseRow);
    expect(index.split(looseRow).length - 1).toBe(1);
    expect(index).toContain('- [`a-file.md`](a-file.md) — *Curated.* `[a]`');
    expect(index).toContain('- [`new.md`](new.md) — *New source.* <!-- draft -->');
    const row = report.updated.find((u) => u.indexPath === 'knowledge/index.md');
    expect(row?.dropped ?? []).toEqual([]);

    // The recovery side classifies the row as protected human content
    // (indexHumanContent keeps every non-draft line), and the generator's
    // rewritten output satisfies that requirement by construction. The pin
    // is discriminating: removing the row loses the protected sequence.
    const requirements = [recoveryProtectedSpans(Buffer.from(before, 'utf8'))];
    expect(() =>
      assertRecoveryRequirements(Buffer.from(index, 'utf8'), requirements),
    ).not.toThrow();
    expect(() =>
      assertRecoveryRequirements(
        Buffer.from(index.replace(`${looseRow}\n`, ''), 'utf8'),
        requirements,
      ),
    ).toThrow('sequence lost');

    // Second run: byte-identical convergence.
    const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
    expect(await readFile('knowledge/index.md')).toBe(index);
    expect(report2.updated).toEqual([]);
  });

  it('still drops a draft loose row whose target is missing', async () => {
    // The engine cleans up its own stale output; only non-draft rows are
    // human-owned under the amendment.
    const stale = '- [gone](gone.md) — Loose. <!-- draft -->';
    await writeFile(
      'knowledge/index.md',
      [
        '# Knowledge',
        '',
        '## Structure',
        '',
        '- [`a-file.md`](a-file.md) — *Curated.* `[a]`',
        stale,
        '',
      ].join('\n'),
    );
    await writeFile('knowledge/a-file.md', '# A\n\nBody A.\n');

    const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
    const index = await readFile('knowledge/index.md');

    const row = report.updated.find((u) => u.indexPath === 'knowledge/index.md');
    expect(row?.dropped).toEqual(['gone']);
    expect(index).not.toContain('gone.md');
    expect(index).toContain('- [`a-file.md`](a-file.md) — *Curated.* `[a]`');
  });

  it('still repairs a loose row canonically when its target exists', async () => {
    // The row keys to the real file child (`loose.md` — the engine keys a
    // bullet by its captured name, so the name must spell the child) — the
    // malformed shape with a real target is still rebuilt from a fresh
    // draft, as before the amendment.
    const keyed = '- [loose.md](loose.md) — Loose row';
    await writeFile('knowledge/index.md', ['# Knowledge', '', keyed, ''].join('\n'));
    await writeFile('knowledge/loose.md', '# Loose\n\nLoose body.\n');

    const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
    const index = await readFile('knowledge/index.md');

    expect(index).toContain('- [`loose.md`](loose.md) — *Loose body.* `[loose]` <!-- draft -->');
    expect(index).not.toContain(keyed);
    const row = report.updated.find((u) => u.indexPath === 'knowledge/index.md');
    expect(row?.dropped ?? []).toEqual([]);

    const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
    expect(await readFile('knowledge/index.md')).toBe(index);
    expect(report2.updated).toEqual([]);
  });

  it('treats a non-draft loose row whose spelling keys to no child as human-owned prose', async () => {
    // The amendment evaluates "target is not a real child" by the engine's
    // canonical keying: `[loose](loose.md)` keys as `loose`, which is not
    // the file child `loose.md` — so the row is human-owned even though a
    // similarly named file exists. The row itself is untouched; the real
    // child still gets its canonical bullet, because every on-disk child is
    // indexed and the human prose never suppresses it.
    const missKeyed = '- [loose](loose.md) — Loose row';
    await writeFile('knowledge/index.md', ['# Knowledge', '', missKeyed, ''].join('\n'));
    await writeFile('knowledge/loose.md', '# Loose\n\nLoose body.\n');

    const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
    const index = await readFile('knowledge/index.md');

    expect(index).toContain(missKeyed);
    expect(index.split(missKeyed).length - 1).toBe(1);
    expect(index).toContain('- [`loose.md`](loose.md) — *Loose body.* `[loose]` <!-- draft -->');
    const row = report.updated.find((u) => u.indexPath === 'knowledge/index.md');
    expect(row?.dropped ?? []).toEqual([]);

    const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
    expect(await readFile('knowledge/index.md')).toBe(index);
    expect(report2.updated).toEqual([]);
  });
});

describe('line-ending preservation', () => {
  it('keeps CRLF line endings when rewriting a CRLF-authored index', async () => {
    await writeFile(
      'knowledge/topics/index.md',
      ['# Topics', '', 'Intro.', '', '## Current files', ''].join('\r\n'),
    );
    await writeFile('knowledge/topics/a-file.md', '# A\n\nBody A.\n');

    await regenerateIndex(conceptionDir, knowledgeStrategy);
    const index = await readFile('knowledge/topics/index.md');

    expect(index).toMatch(/- \[`a-file\.md`\]\(a-file\.md\)/);
    expect(index).toContain('\r\n');
    // Every newline is CRLF — no lone LF introduced by the rewrite.
    expect(/[^\r]\n/.test(index)).toBe(false);
  });
});

describe('regenerateIndex (projects strategy)', () => {
  describe('YAML-frontmatter item tags', () => {
    // Regression test for the bug filed in conception incident
    // 2026-05-09-condash-projects-index-yaml-tags. After the v2.16.0 YAML
    // migration, item-folder bullets in projects/YYYY-MM/index.md were
    // re-derived from the engine's descendant-aggregate map — but the
    // engine never recurses into item folders (they have no `index.md`),
    // so the aggregate was empty and tags came out as `[]`. The fix
    // re-routes leaf-item tags through `strategy.draftSubdirEntry`, which
    // reads the README via `parseHeader` and produces kind/status/apps.

    async function writeProjectsTree(): Promise<void> {
      await writeFile(
        'projects/2026-05/2026-05-09-feature/README.md',
        [
          '---',
          'date: 2026-05-09',
          'kind: project',
          'status: now',
          'apps:',
          '  - condash',
          '  - vcoeur.com',
          '---',
          '',
          '# Feature',
          '',
          '## Goal',
          '',
          'Ship a thing.',
          '',
        ].join('\n'),
      );
    }

    it('drafts an item bullet with kind/status/app tags from YAML frontmatter', async () => {
      await writeProjectsTree();
      await regenerateIndex(conceptionDir, projectsStrategy);
      const monthIndex = await readFile('projects/2026-05/index.md');
      // Tags must lead with kind, status, then app handles (the shared
      // `appHandle` normaliser keeps dots — `vcoeur.com`, not `vcoeur-com`).
      expect(monthIndex).toMatch(
        /- \[`2026-05-09-feature\/`\][^\n]+\*[^*]+\*\s+`\[project, now, condash, vcoeur\.com\]`/,
      );
    });

    it('is idempotent: a second pass leaves the month and root indexes unchanged', async () => {
      await writeProjectsTree();
      await regenerateIndex(conceptionDir, projectsStrategy);
      const monthBefore = await readFile('projects/2026-05/index.md');
      const rootBefore = await readFile('projects/index.md');
      const second = await regenerateIndex(conceptionDir, projectsStrategy);
      expect(second.updated).toEqual([]);
      const monthAfter = await readFile('projects/2026-05/index.md');
      const rootAfter = await readFile('projects/index.md');
      expect(monthAfter).toBe(monthBefore);
      expect(rootAfter).toBe(rootBefore);
    });

    it('rolls item tags up to the month aggregate in a single pass', async () => {
      await writeProjectsTree();
      await regenerateIndex(conceptionDir, projectsStrategy);
      const rootIndex = await readFile('projects/index.md');
      // The month bullet's tag list must include at least one of the
      // items' tags — proves the aggregate sees the descendants on the
      // first pass.
      expect(rootIndex).toMatch(/- \[`2026-05\/`\][^\n]+`\[[^\]]*condash[^\]]*\]`/);
    });
  });

  describe('bullet stability when description carries bracket characters', () => {
    // Regression test for conception incident
    // 2026-05-23-condash-index-bullet-slug-reappend (vcoeur/condash#NNN).
    //
    // The original replaceTagsInBullet regex `/\s*`?\[[^\]]*\]`?\s*$/` allowed
    // the optional-backtick tag block to start matching from a `[` inside the
    // description text. When a project's auto-drafted description contained
    // an unclosed `[` (e.g. a clipped `["@<name>"]` cut mid-token), the
    // regex's leftmost match swallowed the closing italic `*` and the real
    // tag block, leaving a malformed bullet with no closing italic. On the
    // next regen, matchBullet failed on the malformed line and a fresh
    // duplicate was appended — unbounded, one per run.
    it("doesn't corrupt or duplicate bullets whose description gets clipped mid-`[`", async () => {
      // The repro case from the conception incident: a description over
      // 200 chars whose tail array `["@condash"]` is split by the 200-char
      // cap — the clipped desc ends with `[` and no matching `]`, which used
      // to confuse the tag-block regex into eating the closing italic.
      // A status change between pass 1 and pass 2 forces a tag-block
      // rewrite (the only path that exercises replaceTagsInBullet on a
      // mutated raw), so the bug fires.
      const filler =
        'A description engineered so the 200-char clip ends inside a bracketed array, in just the right place ' +
        'to mirror the original conception case: worktrees setup <branch>, empty created[], notPresent: ';
      const longDesc = filler + '["@condash"] and the bare repo lookup misses.';
      const writeReadme = async (status: string): Promise<void> => {
        await writeFile(
          'projects/2026-05/2026-05-14-bracket-bug/README.md',
          [
            '---',
            'date: 2026-05-14',
            'kind: incident',
            `status: ${status}`,
            'apps:',
            '  - condash',
            '---',
            '',
            '# Bracket bug',
            '',
            '## Description',
            '',
            longDesc,
            '',
          ].join('\n'),
        );
      };

      // Pass 1 with status=now drafts a well-formed bullet.
      await writeReadme('now');
      await regenerateIndex(conceptionDir, projectsStrategy);
      const after1 = await readFile('projects/2026-05/index.md');
      const bracketLines1 = after1.match(/^- \[`2026-05-14-bracket-bug.*$/gm) ?? [];
      expect(bracketLines1).toHaveLength(1);
      expect(bracketLines1[0]).toMatch(/— \*[^\n]+\*\.?\s*`\[[^\]]+\]`/);

      // Flip status; pass 2 must re-render the bullet without corrupting
      // the description tail. With the buggy regex this drops the
      // closing italic and the tag block re-attaches mid-description.
      await writeReadme('done');
      await regenerateIndex(conceptionDir, projectsStrategy);
      const after2 = await readFile('projects/2026-05/index.md');
      const bracketLines2 = after2.match(/^- \[`2026-05-14-bracket-bug.*$/gm) ?? [];
      expect(bracketLines2).toHaveLength(1);
      // Closing italic must still be present, with the new tag block
      // immediately after it.
      expect(bracketLines2[0]).toMatch(/— \*[^\n]+\*\.?\s*`\[[^\]]+\]`/);
      expect(bracketLines2[0]).toContain('`[incident, done, condash]`');

      // Pass 3 must be a no-op.
      const report3 = await regenerateIndex(conceptionDir, projectsStrategy);
      const after3 = await readFile('projects/2026-05/index.md');
      expect(after3).toBe(after2);
      expect(report3.updated).toEqual([]);
    });

    it('collapses pre-existing duplicate bullets for the same folder on the next regen', async () => {
      // Simulates an index that already accumulated duplicates from the
      // old bug. After the fix, a single regen should keep one bullet per
      // folder (the engine de-dups by canonical name).
      await writeFile(
        'projects/2026-05/2026-05-14-bracket-bug/README.md',
        [
          '---',
          'date: 2026-05-14',
          'kind: incident',
          'status: done',
          'apps:',
          '  - condash',
          '---',
          '',
          '# Bracket bug',
          '',
          '## Description',
          '',
          'Worktrees setup <branch> path with notPresent: ["@condash"] tail.',
          '',
        ].join('\n'),
      );
      // Hand-write a corrupted index with three duplicate bullets (one
      // well-formed and two malformed — the malformed ones mirror the
      // shape the buggy replaceTagsInBullet used to produce: no closing
      // italic).
      await writeFile(
        'projects/2026-05/index.md',
        [
          '# 2026-05',
          '',
          'Items.',
          '',
          '## Items',
          '',
          '- [`2026-05-14-bracket-bug/`](2026-05-14-bracket-bug/README.md) — *Worktrees setup <branch> path with notPresent: ["@condash"] tail.* `[incident, done, condash]`',
          '- [`2026-05-14-bracket-bug/`](2026-05-14-bracket-bug/README.md) — *Worktrees setup <branch> path with notPresent: `[incident, done, condash]`',
          '- [`2026-05-14-bracket-bug/`](2026-05-14-bracket-bug/README.md) — *Worktrees setup <branch> path with notPresent: `[incident, done, condash]`',
          '',
        ].join('\n'),
      );

      await regenerateIndex(conceptionDir, projectsStrategy);
      const after = await readFile('projects/2026-05/index.md');
      const matches = after.match(/^- \[`2026-05-14-bracket-bug.*$/gm) ?? [];
      expect(matches.length).toBe(1);
    });
  });
});
