#!/usr/bin/env bash
# Called only after fenced runtime replacement, while holding its storage lock.
# The API supplies a short-lived, workspace-scoped recovery capability.
set -euo pipefail
umask 077
exec node --input-type=module - <<'NODE'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, open, rename, rm, stat, readdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const config = JSON.parse(process.env.ZUSE_ARCHIVE_CONFIG);
const { operationId, workspaceId, chatId, sessionId, home, repositoryPath, url, token, key, mode } = config;
const dataPath = process.env.ZUSE_USER_DATA;
if (!dataPath || !home) throw new Error('unsupported archive layout');
const directory = join(home, '.zuse-recovery', operationId);
await mkdir(directory, { recursive: true, mode: 0o700 });
const archive = join(directory, 'state.tar.gz');
const manifestFile = join(directory, 'manifest.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = async path => {
  const checksum = createHash('sha256');
  for await (const bytes of createReadStream(path)) checksum.update(bytes);
  return checksum.digest('hex');
};
const encryptionKey = key === undefined ? undefined : Buffer.from(key, 'base64url');
const aad = index => Buffer.from(`zuse-workspace-archive-v1\n${workspaceId}\n${operationId}\n${index}`);
const request = async (path, method = 'GET', body) => {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(`${url}/${path}`, {
        method, body, headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`archive transport ${response.status}`);
      return await response.text();
    } catch (error) {
      last = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw last;
};
const run = (command, args, input) => {
  const result = spawnSync(command, args, { input, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} archive operation failed`);
  return result.stdout;
};
// Existing destinations are preserved; never overwrite a prior recovery copy.
const installRename = async (source, destination) => {
  try { await stat(destination); throw new Error('recovery destination already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rename(source, destination);
};
const validateDatabase = path => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    if (database.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('archive database integrity failed');
    if (mode === 'backup' && database.prepare('SELECT DISTINCT provider_id FROM sessions').all().some(row => !['claude', 'codex'].includes(row.provider_id))) throw new Error('unsupported native agent recovery layout');
    if (!database.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId) ||
        !database.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) throw new Error('archive conversation identity missing');
  } finally { database.close(); }
};
// Only supported managed roots are captured. Arbitrary external mounts cannot
// silently disappear from a recovery point. Native login files are excluded.
const roots = [
  { name: 'data', path: dataPath, required: true },
  { name: 'repositories', path: config.repositoriesPath ?? '/home/repos', required: true },
  { name: 'claude-projects', path: join(home, '.claude/projects') },
  { name: 'claude-file-history', path: join(home, '.claude/file-history') },
  { name: 'codex', path: join(home, '.codex') },
];
// Python's tarfile is used with explicit member and link validation on both
// sides. No shell expansion or untrusted destination paths are accepted.
const archivePython = String.raw`
import json, os, pathlib, re, sys, tarfile
c = json.loads(sys.stdin.read())
roots = {r['name']: r for r in c['roots']}
# Providers may mount a supported root through a symlink (Boat's /home/repos).
# Capture that root's directory, while retaining strict validation of links
# inside it. Never dereference arbitrary repository or user-data entries.
if c['mode'] == 'backup':
    for root in roots.values():
        root['path'] = os.path.realpath(root['path'])
excluded = {'.cloud-archive', '.workspace-runtime.lock', '.node-compile-cache', 'cloud-runtime-identity.json', 'cloud-runtime-credential', 'github-broker.json'}
def validate(member):
    p = pathlib.PurePosixPath(member.name)
    if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0] not in roots:
        raise ValueError('invalid archive path')
    if not (member.isdir() or member.isfile() or member.issym()):
        raise ValueError('unsupported archive entry')
    if member.issym():
        # Relative links must resolve inside their captured root. Absolute or
        # external links require an explicit recovery contract, never omission.
        target = pathlib.PurePosixPath(member.linkname)
        resolved = os.path.normpath(str(p.parent / target))
        if target.is_absolute() or not (resolved == p.parts[0] or resolved.startswith(p.parts[0] + '/')):
            raise ValueError('external archive symlink')
    return member
if c['mode'] == 'backup':
    observed = {}
    def capture(member):
        parts = pathlib.PurePosixPath(member.name).parts
        if parts[0] == 'repositories' and len(parts) > 1 and parts[1] == '.zuse-archive':
            return None
        if parts[0] == 'data' and len(parts) > 1 and parts[1] in excluded:
            return None
        if parts[0] == 'codex' and len(parts) > 1 and parts[1] not in {'sessions', 'archived_sessions', 'session_index.jsonl'} and not re.fullmatch(r'state_[0-9]+\.sqlite(?:-wal|-shm)?', parts[1]):
            return None
        source = os.path.join(roots[parts[0]]['path'], *parts[1:])
        info = os.lstat(source)
        observed[source] = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
        # Do not capture runtime IPC endpoints or locks as restorable files.
        if not (member.isdir() or member.isfile() or member.issym()):
            raise ValueError('unsupported source entry')
        member.uid = member.gid = 0
        member.uname = member.gname = ''
        return validate(member)
    with tarfile.open(c['archive'] + '.next', 'w:gz', dereference=False) as tar:
        for root in roots.values():
            if not os.path.exists(root['path']):
                if root.get('required'): raise ValueError('required recovery root missing')
                continue
            tar.add(root['path'], arcname=root['name'], filter=capture)
    for source, before in observed.items():
        info = os.lstat(source)
        if before != (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns):
            raise ValueError('source changed during archive')
    os.replace(c['archive'] + '.next', c['archive'])
else:
    stage = c['stage']
    os.makedirs(stage, exist_ok=True)
    with tarfile.open(c['archive'], 'r:gz') as tar:
        members = tar.getmembers()
        for member in members: validate(member)
        # Links may never become extraction parents, irrespective of order.
        links = {m.name.rstrip('/') for m in members if m.issym()}
        for m in members:
            if any(str(p) in links for p in pathlib.PurePosixPath(m.name).parents):
                raise ValueError('archive symlink parent')
        tar.extractall(stage, members=members, numeric_owner=False)
`;

// /home is root-owned, while /home/repos is workspace-owned. Install inside
// that directory so recovery never needs to grant the runtime sudo access.
// Staging and prior-image entries stay on the repository filesystem.
const installRepositories = async (target, source) => {
  const exists = async path => { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const recovery = join(target, '.zuse-archive', operationId);
  const staged = join(recovery, 'incoming');
  const previous = join(recovery, 'previous');
  const journal = join(recovery, 'entries.json');
  await mkdir(previous, { recursive: true, mode: 0o700 });
  let entries;
  try { entries = JSON.parse(await readFile(journal, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!entries) {
    if (!(await exists(staged))) {
      try { await rename(source, staged); }
      catch (error) {
        if (error.code !== 'EXDEV') throw error;
        const copying = join(recovery, 'copying');
        await rm(copying, { recursive: true, force: true });
        await cp(source, copying, { recursive: true, verbatimSymlinks: true });
        await rename(copying, staged);
      }
    }
    const incomingNames = new Set(await readdir(staged));
    if (incomingNames.has('.zuse-archive')) throw new Error('reserved recovery directory in archive');
    const names = new Set([...await readdir(target), ...incomingNames]);
    names.delete('.zuse-archive');
    entries = [...names].map(name => ({ name, incoming: incomingNames.has(name) }));
    await writeFile(`${journal}.next`, JSON.stringify(entries), { mode: 0o600 });
    await rename(`${journal}.next`, journal);
  }
  for (const entry of entries) {
    if (!entry.name || entry.name === '.' || entry.name === '..' || entry.name.includes('/') || entry.name === '.zuse-archive') throw new Error('invalid repository recovery entry');
    const from = join(staged, entry.name);
    const to = join(target, entry.name);
    const saved = join(previous, entry.name);
    if (await exists(from)) {
      if (await exists(to)) await installRename(to, saved);
      await installRename(from, to);
    } else if (entry.incoming) {
      if (!(await exists(to))) throw new Error('restored repository entry missing');
    } else if (await exists(to)) await installRename(to, saved);
  }
};

try {
  if (mode === 'backup') {
    await stat(repositoryPath);
    validateDatabase(join(dataPath, 'zuse.sqlite'));
    // A stopped-writer copy includes WAL and SHM; validation of the extracted
    // copy below verifies committed WAL contents before acknowledging upload.
    let manifest;
    try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!manifest) {
      run('python3', ['-c', archivePython], JSON.stringify({ mode, roots, archive }));
      const verification = join(directory, 'verification');
      run('python3', ['-c', archivePython], JSON.stringify({ mode: 'extract', roots, archive, stage: verification }));
      validateDatabase(join(verification, 'data/zuse.sqlite'));
      await rm(verification, { recursive: true });
      const chunks = [];
      for await (const bytes of createReadStream(archive, { highWaterMark: 4 * 1024 * 1024 })) {
        const index = chunks.length;
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
        cipher.setAAD(aad(index));
        const ciphertext = Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]).toString('base64');
        const digest = hash(ciphertext);
        await writeFile(join(directory, digest), ciphertext, { mode: 0o600 });
        chunks.push(digest);
      }
      manifest = { version: 1, operationId, workspaceId, chatId, sessionId, chunks, archiveSha256: await hashFile(archive) };
      await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
    }
    for (let index = 0; index < manifest.chunks.length; index += 4) {
      await Promise.all(manifest.chunks.slice(index, index + 4).map(async digest =>
        request(digest, 'PUT', await readFile(join(directory, digest), 'utf8'))));
    }
    await request('manifest', 'PUT', JSON.stringify(manifest));
  } else if (mode === 'restore') {
    const receipt = join(directory, 'restored');
    try { if ((await readFile(receipt, 'utf8')) === operationId) process.exit(0); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const manifest = JSON.parse(await request('manifest'));
    if (manifest.version !== 1 || manifest.operationId !== operationId || manifest.workspaceId !== workspaceId || manifest.chatId !== chatId || manifest.sessionId !== sessionId) throw new Error('archive identity mismatch');
    let downloaded = false;
    try { downloaded = (await hashFile(archive)) === manifest.archiveSha256; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!downloaded) {
      const output = await open(`${archive}.next`, 'w', 0o600);
      const checksum = createHash('sha256');
      try {
        for (let start = 0; start < manifest.chunks.length; start += 4) {
          const batch = await Promise.all(manifest.chunks.slice(start, start + 4).map(async (digest, offset) => {
            const ciphertext = await request(digest);
            if (hash(ciphertext) !== digest) throw new Error('archive chunk hash mismatch');
            const bytes = Buffer.from(ciphertext, 'base64');
            const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
            decipher.setAAD(aad(start + offset));
            decipher.setAuthTag(bytes.subarray(-16));
            return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
          }));
          // Transport is parallel, but authenticated chunk order remains exact.
          for (const plaintext of batch) {
            checksum.update(plaintext);
            await output.writeFile(plaintext);
          }
        }
        await output.sync();
      } finally { await output.close(); }
      if (checksum.digest('hex') !== manifest.archiveSha256) throw new Error('archive checksum mismatch');
      await rename(`${archive}.next`, archive);
    }
    const stage = join(directory, 'restore');
    const extracted = join(directory, 'extracted');
    let extractionComplete = false;
    try { extractionComplete = (await readFile(extracted, 'utf8')) === operationId; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!extractionComplete) {
      await rm(stage, { recursive: true, force: true });
      run('python3', ['-c', archivePython], JSON.stringify({ mode: 'extract', roots, archive, stage }));
      validateDatabase(join(stage, 'data/zuse.sqlite'));
      await writeFile(extracted, operationId, { mode: 0o600 });
    }
    for (const root of roots) {
      const incoming = join(stage, root.name);
      const installing = join(directory, `installing-${root.name}`);
      const installed = join(directory, `installed-${root.name}`);
      const exists = async path => { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
      if (await exists(installed)) continue;
      if (root.name === 'repositories') {
        await installRepositories(root.path, incoming);
        await writeFile(installed, operationId, { mode: 0o600 });
        continue;
      }
      if (!(await exists(incoming))) {
        if (await exists(installing)) {
          await stat(root.path);
          await writeFile(installed, operationId);
        } else if (root.required) throw new Error('required archive root missing');
        continue;
      }
      if (!(await exists(installing))) {
        if (root.name === 'data' && await exists(join(root.path, 'zuse.sqlite'))) throw new Error('refusing existing runtime database replacement');
        await writeFile(installing, operationId, { mode: 0o600 });
      }
      // Preserve the image's original directory. An interrupted install can
      // resume without overwriting either the source or the recovered data.
      if (await exists(root.path)) await installRename(root.path, `${root.path}.before-recovery-${operationId}`);
      await mkdir(root.path.substring(0, root.path.lastIndexOf('/')), { recursive: true });
      await installRename(incoming, root.path);
      await writeFile(installed, operationId, { mode: 0o600 });
    }
    validateDatabase(join(dataPath, 'zuse.sqlite'));
    run('sync', []);
    const receiptFile = await open(receipt, 'w', 0o600);
    try { await receiptFile.writeFile(operationId); await receiptFile.sync(); } finally { await receiptFile.close(); }
  } else throw new Error('invalid archive mode');
} catch {
  // Errors must not leak provider credentials, filenames or chat contents.
  await writeFile(join(directory, `failed-${config.expiresAtMs}`), 'archive-operation-failed\n', { mode: 0o600 });
  process.exitCode = 1;
}
NODE
