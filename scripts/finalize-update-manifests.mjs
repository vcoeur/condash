#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseDocument } from 'yaml';

// Linux repacking is the only intentional post-builder mutation. Everything
// else must already match; do not hide naming or packaging defects by guessing.
async function finalize(directory, checkOnly) {
  const names = new Set(await readdir(directory));
  const manifests = [...names].filter((name) => /^latest.*\.yml$/.test(name)).sort();
  if (!manifests.length) throw new Error('No latest*.yml manifests found');
  const artifacts = new Map();
  const writes = [];

  async function artifact(name) {
    if (
      typeof name !== 'string' ||
      !name ||
      /[/\\:%?#\x00-\x1f\x7f]/.test(name) ||
      !/\.(AppImage|deb|dmg|exe)$/.test(name)
    ) {
      throw new Error(`Unsafe or unuploaded artifact name: ${JSON.stringify(name)}`);
    }
    if (!artifacts.has(name)) {
      if (!names.has(name)) throw new Error(`Missing artifact: ${name}`);
      const file = join(directory, name);
      const info = await lstat(file).catch(() => {
        throw new Error(`Missing artifact: ${name}`);
      });
      if (!info.isFile()) throw new Error(`Artifact is not a regular file: ${name}`);
      const hash = createHash('sha512');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      artifacts.set(name, { size: info.size, sha512: hash.digest('base64') });
    }
    return artifacts.get(name);
  }

  function verify(record, actual, label, requireSize) {
    if (record.sha512 !== actual.sha512) throw new Error(`${label}: SHA-512 mismatch`);
    if (
      (requireSize || record.size !== undefined) &&
      (!Number.isSafeInteger(record.size) || record.size !== actual.size)
    ) {
      throw new Error(`${label}: size mismatch`);
    }
  }

  for (const name of manifests) {
    const file = join(directory, name);
    if (!(await lstat(file)).isFile()) throw new Error(`Manifest is not a regular file: ${name}`);
    const original = await readFile(file, 'utf8');
    const document = parseDocument(original);
    if (document.errors.length) throw new Error(`${name}: invalid YAML`);
    const metadata = document.toJS();
    if (!metadata || !Array.isArray(metadata.files) || !metadata.files.length) {
      throw new Error(`${name}: expected nonempty files array`);
    }
    const legacyFile = metadata.files.find((entry) => entry?.url === metadata.path);
    if (!legacyFile) throw new Error(`${name}: path must reference a files entry`);
    let changed = false;
    for (const [index, entry] of metadata.files.entries()) {
      const actual = await artifact(entry?.url);
      const refresh =
        !checkOnly &&
        /^latest-linux(?:-[a-z0-9]+)?\.yml$/.test(name) &&
        entry.url.endsWith('.AppImage');
      if (refresh) {
        for (const field of ['size', 'sha512']) {
          if (entry[field] !== actual[field]) {
            document.setIn(['files', index, field], actual[field]);
            entry[field] = actual[field];
            changed = true;
          }
          if (entry === legacyFile && (field === 'sha512' || metadata.size !== undefined)) {
            if (metadata[field] !== actual[field]) {
              document.set(field, actual[field]);
              metadata[field] = actual[field];
              changed = true;
            }
          }
        }
      }
      verify(entry, actual, `${name}: ${entry.url}`, true);
    }
    verify(metadata, await artifact(metadata.path), `${name}: path ${metadata.path}`, false);
    if (changed) writes.push({ file, content: document.toString() });
  }

  // Validate the whole set first, so an unrelated broken manifest cannot leave
  // a partially refreshed release directory that looks ready to upload.
  for (const { file, content } of writes) await writeFile(file, content);
  console.log(
    `Verified ${manifests.length} manifests and ${artifacts.size} artifacts; refreshed ${writes.length} Linux manifests.`,
  );
}

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2 || (args[1] !== undefined && args[1] !== '--check')) {
  console.error('Usage: node scripts/finalize-update-manifests.mjs <release-directory> [--check]');
  process.exitCode = 1;
} else {
  await finalize(resolve(args[0]), args[1] === '--check').catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
