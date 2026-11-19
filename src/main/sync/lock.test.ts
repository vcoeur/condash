import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireRecoveryLease,
  acquireDeferredSyncLock,
  acquireSyncLock,
  inspectRecoveryEvidence,
  promoteSyncLock,
  readProcessIdentity,
} from './lock';

const LOCK = 'condash-sync.lock';

describe('acquireSyncLock', () => {
  let gitDir: string;

  beforeEach(async () => {
    gitDir = await fs.mkdtemp(join(tmpdir(), 'condash-lock-test-'));
  });

  afterEach(async () => {
    await fs.rm(gitDir, { recursive: true, force: true });
  });

  it('acquires when free and records the holder', async () => {
    const result = await acquireSyncLock(gitDir);
    expect(result.acquired).toBe(true);

    const raw = JSON.parse(await fs.readFile(join(gitDir, LOCK), 'utf8'));
    expect(raw.pid).toBe(process.pid);
    expect(typeof raw.startedAt).toBe('string');
  });

  it('releases so the next caller can acquire', async () => {
    const first = await acquireSyncLock(gitDir);
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;
    await first.lock.release();

    await expect(fs.stat(join(gitDir, LOCK))).rejects.toThrow();
    const second = await acquireSyncLock(gitDir);
    expect(second.acquired).toBe(true);
  });

  it('refuses when a live process holds it, reporting the holder', async () => {
    // `process.pid` is alive by definition, so this stands in for a running
    // sweeper without needing to fork one.
    await fs.writeFile(
      join(gitDir, LOCK),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const result = await acquireSyncLock(gitDir);
    expect(result.acquired).toBe(false);
    if (result.acquired) return;
    expect(result.heldBy?.pid).toBe(process.pid);
  });

  it('steals a lock whose holder is gone', async () => {
    // pid 2^22 + 1 is above every Linux/macOS pid_max, so it cannot be live.
    await fs.writeFile(
      join(gitDir, LOCK),
      JSON.stringify({ pid: 4_194_305, startedAt: new Date().toISOString() }),
    );

    const result = await acquireSyncLock(gitDir);
    expect(result.acquired).toBe(true);
    const raw = JSON.parse(await fs.readFile(join(gitDir, LOCK), 'utf8'));
    expect(raw.pid).toBe(process.pid);
  });

  it('steals an unparseable lock', async () => {
    await fs.writeFile(join(gitDir, LOCK), 'not json at all');
    const result = await acquireSyncLock(gitDir);
    expect(result.acquired).toBe(true);
  });

  it('steals a lock older than the stale window even if its pid is alive', async () => {
    const lockPath = join(gitDir, LOCK);
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(lockPath, twoHoursAgo, twoHoursAgo);

    const result = await acquireSyncLock(gitDir);
    expect(result.acquired).toBe(true);
  });
});

describe('recovery lease, discovery and owned release (real processes)', () => {
  let base: string;
  let gitDir: string;
  let bundle: string;
  const children = new Set<ChildProcess>();
  const leases: { close(): Promise<void> }[] = [];

  beforeAll(async () => {
    base = await fs.mkdtemp(join(tmpdir(), 'condash-recovery-lock-'));
    bundle = join(base, 'lock.cjs');
    await build({
      entryPoints: [join(process.cwd(), 'src/main/sync/lock.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundle,
    });
  });
  beforeEach(async () => {
    gitDir = await fs.mkdtemp(join(base, 'git-'));
  });
  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = exited(child);
        child.kill('SIGKILL');
        await stopped;
      }
    }
    children.clear();
    for (const lease of leases.splice(0)) await lease.close();
  });
  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  function exited(
    child: ChildProcess,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (child.exitCode !== null || child.signalCode !== null)
      return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    return new Promise((resolveExit, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Fixture child exit deadline'));
      }, 5000);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal });
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function message(child: ChildProcess, type: string): Promise<Record<string, any>> {
    return new Promise((resolveMessage, reject) => {
      const timer = setTimeout(() => {
        child.off('message', listener);
        reject(new Error(`Fixture message deadline: ${type}`));
      }, 5000);
      const listener = (value: any) => {
        if (value.type !== type) return;
        clearTimeout(timer);
        child.off('message', listener);
        resolveMessage(value);
      };
      child.on('message', listener);
    });
  }

  function childOwner(promote = true): ChildProcess {
    const source = `
      const api = require(${JSON.stringify(bundle)});
      (async () => {
        const result = await api.acquireSyncLock(${JSON.stringify(gitDir)});
        if (!result.acquired) throw new Error('Fixture owner could not acquire');
        const lock = result.lock;
        let lease = ${promote} ? await api.promoteSyncLock(lock) : null;
        process.on('message', async command => {
          try {
            if (command === 'promote') { lease = await api.promoteSyncLock(lock); process.send({type:'promoted'}); }
            if (command === 'assert') { await lease.assertOwned(); await lock.assertOwned(); process.send({type:'asserted',owned:true}); }
            if (command === 'release') { await lock.release(); if (lease) await lease.close(); process.send({type:'released'}, () => process.exit(0)); }
          } catch (error) { process.send({type:command==='assert'?'asserted':'failed',owned:false,error:String(error)}); }
        });
        process.send({type:'ready',token:lock.token,helperPid:lease?.helperPid});
      })().catch(error => { process.send({type:'failed',error:String(error)}, () => process.exit(1)); });
    `;
    const child = spawn(process.execPath, ['-e', source], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.stdout!.resume();
    child.stderr!.resume();
    children.add(child);
    return child;
  }

  it('pins nonce/inode/process identity and never releases a replacement ordinary token', async () => {
    const first = await acquireSyncLock(gitDir);
    if (!first.acquired) throw new Error('Fixture acquire failed');
    expect(first.lock.token).toMatchObject({
      pid: process.pid,
      bootId: expect.any(String),
      processStart: expect.any(String),
      nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    const old = new Date(0);
    await fs.utimes(first.lock.path, old, old);
    const replacement = await acquireSyncLock(gitDir);
    if (!replacement.acquired) throw new Error('Fixture takeover failed');
    await first.lock.release();
    await replacement.lock.assertOwned();
    expect(replacement.lock.token.nonce).not.toBe(first.lock.token.nonce);
    await replacement.lock.release();
  });

  it.each(['malformed', 'dead', 'aged-live'])(
    'retains the %s lock unchanged when arbitration is unavailable',
    async (holder) => {
      const path = join(gitDir, LOCK);
      await fs.writeFile(
        path,
        holder === 'malformed'
          ? 'malformed legacy holder'
          : JSON.stringify({
              pid: holder === 'dead' ? 4_194_305 : process.pid,
              startedAt: new Date(0).toISOString(),
            }),
      );
      await fs.utimes(path, new Date(0), new Date(0));
      const before = await fs.readFile(path);
      const stat = await fs.stat(path, { bigint: true });
      await expect(
        acquireSyncLock(gitDir, { acquireLease: async () => ({ kind: 'unavailable' }) }),
      ).rejects.toThrow('arbitration unavailable');
      expect(await fs.readFile(path)).toEqual(before);
      expect((await fs.stat(path, { bigint: true })).ino).toBe(stat.ino);
    },
  );

  it('still acquires and releases a free ordinary lock on a stably unavailable-capability host', async () => {
    const result = await acquireSyncLock(gitDir, {
      acquireLease: async () => ({ kind: 'unavailable' }),
    });
    if (!result.acquired) throw new Error('Free ordinary acquisition refused');
    await result.lock.assertOwned();
    await result.lock.release();
    await expect(fs.stat(join(gitDir, LOCK))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a separate unavailable-capability stale contender paused inside the old release, then preserves its later free acquisition', async () => {
    const unavailable = async () => ({ kind: 'unavailable' as const });
    const first = await acquireSyncLock(gitDir, { acquireLease: unavailable });
    if (!first.acquired) throw new Error('Fixture free acquisition failed');
    await fs.utimes(first.lock.path, new Date(0), new Date(0));
    const nativeUnlink = fs.unlink;
    let intercepted = false;
    let child: ChildProcess | null = null;
    fs.unlink = async (path) => {
      if (path === first.lock.path && !intercepted) {
        intercepted = true;
        const program = `const api=require(${JSON.stringify(bundle)});let lock;(async()=>{try{const result=await api.acquireSyncLock(${JSON.stringify(gitDir)},{acquireLease:async()=>({kind:'unavailable'})});lock=result.lock;process.send({type:'attempt',acquired:result.acquired});}catch(error){process.send({type:'attempt',acquired:false,error:String(error)});}process.on('message',async command=>{try{if(command==='acquire'){const result=await api.acquireSyncLock(${JSON.stringify(gitDir)},{acquireLease:async()=>({kind:'unavailable'})});lock=result.lock;process.send({type:'acquired',acquired:result.acquired,token:lock.token});}if(command==='check'){await lock.assertOwned();process.send({type:'checked',owned:true});}if(command==='release'){await lock.release();process.send({type:'released'},()=>process.exit(0));}}catch(error){process.send({type:'failed',error:String(error)},()=>process.exit(1));}});})().catch(()=>process.exit(1));`;
        child = spawn(process.execPath, ['-e', program], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        child.stdout!.resume();
        child.stderr!.resume();
        children.add(child);
        const attempt = await message(child, 'attempt');
        expect(attempt.acquired).toBe(false);
        expect(attempt.error).toContain('arbitration unavailable');
        expect(JSON.parse(await fs.readFile(first.lock.path, 'utf8')).nonce).toBe(
          first.lock.token.nonce,
        );
      }
      await nativeUnlink(path);
    };
    try {
      await first.lock.release();
      expect(intercepted).toBe(true);
      const contender = child as ChildProcess | null;
      if (!contender) throw new Error('Fixture contender missing');
      const acquired = message(contender, 'acquired');
      contender.send('acquire');
      expect((await acquired).acquired).toBe(true);
      await first.lock.release();
      const checked = message(contender, 'checked');
      contender.send('check');
      expect((await checked).owned).toBe(true);
      process.kill(contender.pid!, 0);
      const released = message(contender, 'released');
      contender.send('release');
      await released;
      expect(await exited(contender)).toEqual({ code: 0, signal: null });
    } finally {
      fs.unlink = nativeUnlink;
    }
  }, 20_000);

  it('does not turn uncertain probing into an unsafe unavailable-capability release', async () => {
    let uncertain = true;
    const result = await acquireSyncLock(gitDir, {
      acquireLease: async (directory) => {
        if (uncertain)
          throw Object.assign(new Error('fixture probe uncertainty'), { code: 'EAGAIN' });
        return acquireRecoveryLease(directory);
      },
    });
    if (!result.acquired) throw new Error('Free ordinary acquisition refused');
    await expect(result.lock.release()).rejects.toThrow('probe uncertainty');
    await result.lock.assertOwned();
    uncertain = false;
    await result.lock.release();
    await expect(fs.stat(result.lock.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('the deferred-token primitive never age-steals a live old holder', async () => {
    const old = await acquireSyncLock(gitDir);
    if (!old.acquired) throw new Error('Fixture acquire failed');
    await fs.utimes(old.lock.path, new Date(0), new Date(0));
    const result = await acquireRecoveryLease(gitDir);
    if (result.kind !== 'acquired') throw new Error('Fixture lease failed');
    leases.push(result.lease);
    await expect(acquireDeferredSyncLock(gitDir, result.lease, 'a'.repeat(32))).rejects.toThrow(
      'token is present',
    );
    await old.lock.assertOwned();
    await result.lease.close();
    await old.lock.release();
  });

  it('the deferred-token primitive can take an actually released token only under its own directory lease', async () => {
    const old = await acquireSyncLock(gitDir);
    if (!old.acquired) throw new Error('Fixture acquire failed');
    await old.lock.release();
    const result = await acquireRecoveryLease(gitDir);
    if (result.kind !== 'acquired') throw new Error('Fixture lease failed');
    leases.push(result.lease);
    await expect(acquireDeferredSyncLock(base, result.lease, 'a'.repeat(32))).rejects.toThrow(
      'Foreign',
    );
    const claimed = await acquireDeferredSyncLock(gitDir, result.lease, 'a'.repeat(32));
    await claimed.assertOwned();
    expect(claimed.token.nonce).not.toBe(old.lock.token.nonce);
    await expect(claimed.release()).rejects.toThrow('generic release is forbidden');
    await result.lease.close();
    await expect(result.lease.assertOwned()).rejects.toThrow('ownership lost');
  });

  it.each(['timeout', 'malformed'])(
    'registers and reaps the direct pre-ready helper after %s without killing its live owner',
    async (failure) => {
      let helper: ChildProcess | null = null;
      let identity: Awaited<ReturnType<typeof readProcessIdentity>> = null;
      const operation = acquireRecoveryLease(gitDir, {
        timeoutMs: failure === 'timeout' ? 100 : 1500,
        spawnHelper: (file, args, options) =>
          spawn(
            file,
            [
              ...args.slice(0, -1),
              failure === 'timeout'
                ? 'setInterval(()=>{},1000)'
                : 'console.log("not-json readiness");setInterval(()=>{},1000)',
            ],
            options,
          ),
        spawned: async (child, registered) => {
          helper = child;
          identity = registered;
        },
      });
      await expect(operation).rejects.toThrow(
        failure === 'timeout' ? /deadline/ : /JSON|Unexpected token/,
      );
      const registered = helper as ChildProcess | null;
      expect(registered).not.toBeNull();
      expect(identity).not.toBeNull();
      expect(registered!.signalCode).toBe('SIGKILL');
      expect(await readProcessIdentity(registered!.pid!)).toBeNull();
      process.kill(process.pid, 0);
      const reacquired = await acquireRecoveryLease(gitDir);
      expect(reacquired.kind).toBe('acquired');
      if (reacquired.kind === 'acquired') {
        leases.push(reacquired.lease);
        await reacquired.lease.assertOwned();
      }
    },
    10_000,
  );

  it.each(['after-create', 'before-stale-recheck'] as const)(
    'rereads evidence at %s and leaves newly found partial evidence unresolved',
    async (point) => {
      if (point === 'before-stale-recheck')
        await fs.writeFile(join(gitDir, LOCK), 'malformed legacy holder');
      await expect(
        acquireSyncLock(gitDir, {
          boundary: async (boundary) => {
            if (boundary === point)
              await fs.mkdir(join(gitDir, 'condash-index-recovery'), { mode: 0o700 });
          },
        }),
      ).rejects.toThrow('Unresolved index recovery');
      if (point === 'after-create')
        await expect(fs.stat(join(gitDir, LOCK))).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await fs.readFile(join(gitDir, LOCK), 'utf8')).toBe('malformed legacy holder');
    },
  );

  it('a promoted prepublication owner cannot be age-stolen by another process', async () => {
    const owner = childOwner();
    const ready = await message(owner, 'ready');
    await fs.utimes(join(gitDir, LOCK), new Date(0), new Date(0));
    const before = await fs.readFile(join(gitDir, LOCK));
    const contender = await acquireSyncLock(gitDir);
    expect(contender.acquired).toBe(false);
    expect(await fs.readFile(join(gitDir, LOCK))).toEqual(before);
    expect(await inspectRecoveryEvidence(gitDir)).toEqual([]);
    expect(ready.helperPid).not.toBe(owner.pid);
    const released = message(owner, 'released');
    owner.send('release');
    await released;
    expect(await exited(owner)).toEqual({ code: 0, signal: null });
  });

  it.each([73, 1])(
    'waits for observed exit %s after pre-readiness pipe EOF instead of inferring conflict or availability',
    async (code) => {
      const holder = await acquireRecoveryLease(gitDir);
      if (holder.kind !== 'acquired') throw new Error('Fixture lease unavailable');
      leases.push(holder.lease);
      let child: ChildProcess | null = null;
      let eofBeforeExit = false;
      const attempt = acquireRecoveryLease(gitDir, {
        spawnHelper: (_file, _args, options) => {
          child = spawn(
            process.execPath,
            ['-e', `process.stdin.once('data',()=>process.exit(${code}));process.stdout.end();`],
            options,
          );
          children.add(child);
          return child;
        },
        spawned: async (helper, identity) => {
          expect(identity).not.toBeNull();
          if (!helper.stdout!.readableEnded)
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('Fixture EOF deadline')), 3000);
              helper.stdout!.once('end', () => {
                clearTimeout(timer);
                resolve();
              });
            });
          expect(helper.exitCode).toBeNull();
          eofBeforeExit = true;
          setImmediate(() => helper.stdin!.write('exit\n'));
        },
      });
      if (code === 73) expect(await attempt).toEqual({ kind: 'busy' });
      else await expect(attempt).rejects.toThrow('helper unavailable');
      expect(eofBeforeExit).toBe(true);
      if (!child) throw new Error('Fixture helper missing');
      expect(await exited(child)).toEqual({ code, signal: null });
      await holder.lease.assertOwned();
      expect(await readProcessIdentity(process.pid)).not.toBeNull();
    },
    15_000,
  );

  it('an ordinary takeover before promotion prevents the old process from promoting or releasing our token', async () => {
    const owner = childOwner(false);
    await message(owner, 'ready');
    await fs.utimes(join(gitDir, LOCK), new Date(0), new Date(0));
    const current = await acquireSyncLock(gitDir);
    if (!current.acquired) throw new Error('Fixture takeover failed');
    const failed = message(owner, 'failed');
    owner.send('promote');
    expect((await failed).error).toMatch(/Sync lock (ownership lost|token drift)/);
    const released = message(owner, 'released');
    owner.send('release');
    await released;
    await current.lock.assertOwned();
    await current.lock.release();
  });

  it('helper death releases the kernel lease while the owner stays alive and rejects further owner mutation', async () => {
    const owner = childOwner();
    const ready = await message(owner, 'ready');
    process.kill(ready.helperPid, 'SIGKILL');
    const asserted = message(owner, 'asserted');
    owner.send('assert');
    expect((await asserted).owned).toBe(false);
    expect(owner.exitCode).toBeNull();
    expect(owner.signalCode).toBeNull();
    process.kill(owner.pid!, 0);
    const result = await acquireRecoveryLease(gitDir);
    expect(result.kind).toBe('acquired');
    if (result.kind === 'acquired') {
      leases.push(result.lease);
      await result.lease.assertOwned();
    }
  });

  it('owner death eventually relinquishes the helper lease without treating active evidence as absent', async () => {
    const owner = childOwner();
    const ready = await message(owner, 'ready');
    const active = join(gitDir, 'condash-index-recovery/active');
    await fs.mkdir(active, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(active, 'manifest.json'),
      JSON.stringify({ version: 1, generation: 1, phase: 'active', owner: ready.token }),
      { mode: 0o600 },
    );
    const stopped = exited(owner);
    owner.kill('SIGKILL');
    expect(await stopped).toEqual({ code: null, signal: 'SIGKILL' });
    await expect(acquireSyncLock(gitDir)).rejects.toThrow('Unresolved index recovery');
    let result = await acquireRecoveryLease(gitDir);
    const deadline = Date.now() + 3000;
    while (result.kind === 'busy' && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      result = await acquireRecoveryLease(gitDir);
    }
    expect(result.kind).toBe('acquired');
    if (result.kind === 'acquired') leases.push(result.lease);
  });

  it.each([
    'empty-root',
    'empty-active',
    'bad-manifest',
    'pending-archive',
    'wrong-mode',
    'symlink-root',
  ])('discovers %s before ordinary takeover or fast-path token creation', async (shape) => {
    const root = join(gitDir, 'condash-index-recovery');
    if (shape === 'symlink-root') await fs.symlink(gitDir, root);
    else {
      await fs.mkdir(root, { mode: 0o700 });
      if (shape === 'wrong-mode') await fs.chmod(root, 0o755);
      if (shape === 'empty-active' || shape === 'bad-manifest') {
        await fs.mkdir(join(root, 'active'), { mode: 0o700 });
        if (shape === 'bad-manifest')
          await fs.writeFile(join(root, 'active/manifest.json'), '{', { mode: 0o600 });
      }
      if (shape === 'pending-archive') {
        const archive = join(root, 'resolved/one');
        await fs.mkdir(archive, { recursive: true, mode: 0o700 });
        await fs.writeFile(
          join(archive, 'manifest.json'),
          JSON.stringify({
            version: 1,
            generation: 3,
            phase: 'archive-pending',
            archiveName: 'one',
            owner: { nonce: 'fixture' },
          }),
          { mode: 0o600 },
        );
      }
    }
    expect((await inspectRecoveryEvidence(gitDir)).length).toBeGreaterThan(0);
    await expect(acquireSyncLock(gitDir)).rejects.toThrow('Unresolved index recovery');
    await expect(fs.stat(join(gitDir, LOCK))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects arbitration inode replacement after readiness and leaves the never-unlinked path present', async () => {
    const normal = await acquireSyncLock(gitDir);
    if (!normal.acquired) throw new Error('Fixture acquire failed');
    const lease = await promoteSyncLock(normal.lock);
    leases.push(lease);
    const path = join(gitDir, 'condash-index-recovery.lock');
    await fs.rename(path, path + '.old');
    await fs.writeFile(path, '', { mode: 0o600 });
    await expect(lease.assertOwned()).rejects.toThrow('ownership lost');
    await lease.close();
    expect((await fs.stat(path)).isFile()).toBe(true);
  });
});
