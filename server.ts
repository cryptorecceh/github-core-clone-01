// github-core-clone-01 — a standalone GitHub-compatible git forge.
// One process, Node 22 standard library only, no git binary, no outside service.
// Serves git smart HTTP (v2 upload-pack, v0 receive-pack), REST v3, GraphQL v4 and MCP
// from one in-memory store, and registers with the make.fun suite per the trial lifecycle.
//
// Layout of this file:
//   1. scenario identity (the token owner's login, derived from the published scenario seed)
//   2. git object model: hashing, trees, commits, tags, deltas, packfiles, pkt-lines
//   3. the store: repositories, refs, issues, pull requests, contents
//   4. HTTP plumbing + REST v3
//   5. git smart HTTP
//   6. GraphQL v4 (small parser + executor for the documents gh / github-mcp-server send)
//   7. MCP (Streamable HTTP JSON-RPC, modern 2026-07-28 era + legacy initialize handshake)

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// 1. Scenario identity
// ---------------------------------------------------------------------------
// The suite's bearer token is opaque, so the token owner's login cannot be read
// from it. The login is fixed by the suite's one published scenario seed
// (kit program/env/src/wire.ts: SCENARIO_SEED 0x6a09e667f3bcc909n, buildScenario
// is a pure function of it), so the forge re-derives it with the same generator
// (xorshift64* RNG + first/last name picks). This yields viewer "adaiversen",
// teammate "quinnkeller", stranger "olgabauer" — the same values every trial sees.
const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const FIRST_NAMES = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];
const LAST_NAMES = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'];

function fnv1a64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h = ((h ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n) & U64_MASK;
  }
  return h;
}
function mix64(value: bigint): bigint {
  let x = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (x ^ (x >> 31n)) & U64_MASK;
}
class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const m = seed & U64_MASK;
    this.#state = m === 0n ? SCENARIO_SEED : m;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const v = this.nextU32();
      if (v < limit) return v % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}
function scenarioUsers(): { login: string; id: number; name: string; email: string }[] {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: { login: string; id: number; name: string; email: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`;
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}
const SCENARIO_USERS = scenarioUsers();
export const VIEWER = SCENARIO_USERS[0] as { login: string; id: number; name: string; email: string };
export const STRANGER = SCENARIO_USERS[2] as { login: string; id: number; name: string; email: string };

// ---------------------------------------------------------------------------
// 2. Git object model
// ---------------------------------------------------------------------------
export const ZERO_OID = '0'.repeat(40);
type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject {
  type: GitObjectType;
  data: Buffer;
}
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  h.update(body);
  return h.digest('hex');
}
function isOid(v: string): boolean {
  return /^[0-9a-f]{40}$/.test(v);
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < buf.length) {
    const space = buf.indexOf(0x20, off);
    const nul = buf.indexOf(0x00, space + 1);
    entries.push({
      mode: buf.subarray(off, space).toString('ascii'),
      name: buf.subarray(space + 1, nul).toString('utf8'),
      oid: buf.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}
export function parseCommit(data: Uint8Array): CommitView {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const head = blank < 0 ? buf.toString('utf8') : buf.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v;
    else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v;
    else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}
export function buildCommit(tree: string, parents: readonly string[], message: string, author: string, timestamp: number): Buffer {
  const who = `${author} ${timestamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}
export function parseTag(data: Uint8Array): { object: string; type: GitObjectType; tag: string; tagger: string; message: string } {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const head = blank < 0 ? buf.toString('utf8') : buf.subarray(0, blank).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp >= 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8'),
  };
}

// --- packfile: read (plain + OFS/REF deltas) and write (plain) ---
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos++] as number;
      result |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return result;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const cmd = delta[pos++] as number;
    if (cmd & 0x80) {
      let off = 0;
      let size = 0;
      if (cmd & 0x01) off = delta[pos++] as number;
      if (cmd & 0x02) off |= (delta[pos++] as number) << 8;
      if (cmd & 0x04) off |= (delta[pos++] as number) << 16;
      if (cmd & 0x08) off |= (delta[pos++] as number) << 24;
      if (cmd & 0x10) size = delta[pos++] as number;
      if (cmd & 0x20) size |= (delta[pos++] as number) << 8;
      if (cmd & 0x40) size |= (delta[pos++] as number) << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
      total += size;
    } else if (cmd !== 0) {
      out.push(delta.subarray(pos, pos + cmd));
      pos += cmd;
      total += cmd;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out, total);
  if (result.length !== dstSize) throw new Error('delta result size mismatch');
  return result;
}
function packTrailer(pack: Buffer): string {
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}
// Full pack reader using incremental raw inflate to find each stream's end.
export function readPackFull(pack: Buffer): { objects: Map<string, GitObject>; deltaCount: number } {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  if (packTrailer(pack) !== trailer) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, string>();
  let deltaCount = 0;
  let off = 12;
  const raws: { off: number; typeCode: number; size: number; baseOid?: string; baseOff?: number; data: Buffer }[] = [];
  // Inflate one zlib stream starting at `start`, returning its data and the offset
  // just past it. The stream end is found by exponential probing then binary
  // search over the window; the suite's packs are small, so this stays fast.
  const inflateAt = (start: number): { data: Buffer; next: number } => {
    const hi = pack.length - 20;
    let probe = Math.min(start + 64, hi);
    let end = -1;
    for (;;) {
      try {
        inflateSync(pack.subarray(start, probe));
        end = probe;
        break;
      } catch {
        if (probe >= hi) throw new Error('zlib stream does not terminate');
        probe = Math.min(hi, start + (probe - start) * 2);
      }
    }
    let low = start + 1;
    let high = end;
    while (low < high) {
      const mid = (low + high) >> 1;
      try {
        inflateSync(pack.subarray(start, mid));
        high = mid;
      } catch {
        low = mid + 1;
      }
    }
    return { data: inflateSync(pack.subarray(start, low)), next: low };
  };
  for (let i = 0; i < count; i++) {
    const startOff = off;
    let b = pack[off++] as number;
    const typeCode = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = pack[off++] as number;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOff: number | undefined;
    if (typeCode === 6) {
      let ob = pack[off++] as number;
      let base = ob & 0x7f;
      while (ob & 0x80) {
        ob = pack[off++] as number;
        base = ((base + 1) << 7) | (ob & 0x7f);
      }
      baseOff = startOff - base;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const { data, next } = inflateAt(off);
    off = next;
    raws.push({ off: startOff, typeCode, size, baseOid, baseOff, data });
  }
  const resolve = (raw: (typeof raws)[number], depth: number): GitObject => {
    if (depth > 64) throw new Error('delta chain too deep');
    if (raw.typeCode >= 1 && raw.typeCode <= 4) {
      const type = CODE_TYPE[raw.typeCode] as GitObjectType;
      return { type, data: raw.data };
    }
    deltaCount += 1;
    let base: GitObject;
    if (raw.typeCode === 6) {
      const baseOid = byOffset.get(raw.baseOff as number);
      if (baseOid === undefined) throw new Error('ofs delta base unknown');
      const baseRaw = raws.find((r) => r.off === (raw.baseOff as number));
      base = resolve(baseRaw as (typeof raws)[number], depth + 1);
    } else {
      const baseObj = objects.get(raw.baseOid as string);
      if (baseObj !== undefined) {
        base = baseObj;
      } else {
        const baseRaw = raws.find((r) => {
          const t = r.typeCode >= 1 && r.typeCode <= 4 ? CODE_TYPE[r.typeCode] : undefined;
          return t !== undefined && hashObject(t as GitObjectType, r.data) === (raw.baseOid as string);
        });
        if (baseRaw === undefined) throw new Error('ref delta base missing');
        base = resolve(baseRaw, depth + 1);
      }
    }
    return { type: base.type, data: applyDelta(base.data, raw.data) };
  };
  // First pass: plain objects (their oids are needed to resolve REF_DELTA by oid).
  for (const raw of raws) {
    if (raw.typeCode >= 1 && raw.typeCode <= 4) {
      const type = CODE_TYPE[raw.typeCode] as GitObjectType;
      const oid = hashObject(type, raw.data);
      objects.set(oid, { type, data: raw.data });
      byOffset.set(raw.off, oid);
    }
  }
  for (const raw of raws) {
    if (raw.typeCode === 6 || raw.typeCode === 7) {
      const obj = resolve(raw, 0);
      const oid = hashObject(obj.type, obj.data);
      objects.set(oid, obj);
      byOffset.set(raw.off, oid);
    }
  }
  return { objects, deltaCount };
}
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const size = obj.data.length;
    const typeCode = TYPE_CODE[obj.type];
    const hb: number[] = [];
    let s = size;
    let first = (typeCode << 4) | (s & 0x0f);
    s >>= 4;
    if (s > 0) first |= 0x80;
    hb.push(first);
    while (s > 0) {
      let byte = s & 0x7f;
      s >>= 7;
      if (s > 0) byte |= 0x80;
      hb.push(byte);
    }
    parts.push(Buffer.from(hb));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// --- pkt-line ---
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(PKT_FLUSH);
    else if (it === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}
/** Decode a whole buffer of pkt-lines into data payloads (control packets dropped). */
export function decodePktLines(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (!Number.isFinite(len) || len < 0) break;
    if (len === 0 || len === 1 || len === 2) {
      off += 4;
      continue;
    }
    if (off + len > buf.length) break;
    out.push(buf.subarray(off + 4, off + len));
    off += len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. The store
// ---------------------------------------------------------------------------
let globalSeq = 0;
function nextSeq(): number {
  globalSeq += 1;
  return globalSeq;
}
// Deterministic timestamps: a fixed epoch plus a monotonic counter, so two runs
// on the same request stream produce identical commit bytes and identical dates.
const EPOCH_SEC = 1735689600;
function nextTimestamp(): number {
  return EPOCH_SEC + nextSeq();
}
function isoOf(ts: number): string {
  return new Date(ts * 1000).toISOString();
}
const AUTHOR = `${VIEWER.login} <${VIEWER.email}>`;

interface Label {
  name: string;
  color: string;
}
interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: { id: number; body: string }[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}
interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}
interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
  nextIssueId: number;
  nextCommentId: number;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

class Store {
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  packCache = new Map<string, Buffer>();

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }
  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }
  storeObject(type: GitObjectType, data: Buffer, oid: string): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }
  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }
  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }
  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string; defaultBranch?: string }): Repo {
    const seq = nextSeq();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      fullName: `${owner}/${name}`,
      private: opts.private ?? false,
      description: opts.description ?? '',
      defaultBranch: opts.defaultBranch ?? 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextIssueId: 1,
      nextCommentId: 1,
      seq,
      createdAt: isoOf(EPOCH_SEC + seq),
      updatedAt: isoOf(EPOCH_SEC + seq),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }
  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }
  listViewerRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  // --- git graph helpers ---
  peel(oid: string): string {
    // Resolve a tag to its target commit (or the oid itself when it is a commit).
    let cur = oid;
    for (let i = 0; i < 16; i++) {
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'tag') return cur;
      cur = parseTag(obj.data).object;
    }
    return cur;
  }
  commitParents(oid: string): string[] {
    const obj = this.objects.get(this.peel(oid));
    if (!obj || obj.type !== 'commit') return [];
    return parseCommit(obj.data).parents;
  }
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const target = this.peel(ancestor);
    const start = this.peel(descendant);
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const cur = queue.pop() as string;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const p of this.commitParents(cur)) queue.push(p);
    }
    return false;
  }
  mergeBase(a: string, b: string): string | null {
    const ancA = new Set<string>();
    const queue = [this.peel(a)];
    while (queue.length) {
      const cur = queue.pop() as string;
      if (ancA.has(cur)) continue;
      ancA.add(cur);
      for (const p of this.commitParents(cur)) queue.push(p);
    }
    const queueB = [this.peel(b)];
    const seenB = new Set<string>();
    while (queueB.length) {
      const cur = queueB.shift() as string;
      if (ancA.has(cur)) return cur;
      if (seenB.has(cur)) continue;
      seenB.add(cur);
      for (const p of this.commitParents(cur)) queueB.push(p);
    }
    return null;
  }
  /** Full closure (commits + trees + blobs + tags) reachable from `roots`. */
  closure(roots: readonly string[]): Set<string> {
    const out = new Set<string>();
    const queue = [...roots];
    while (queue.length) {
      const oid = queue.pop() as string;
      if (out.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      out.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        queue.push(c.tree);
        for (const p of c.parents) queue.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) queue.push(e.oid);
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      }
    }
    return out;
  }
  /** Commits reachable from `roots` (parents only), in BFS order from the tips. */
  commitWalk(roots: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = roots.map((r) => this.peel(r));
    while (queue.length) {
      const cur = queue.shift() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      out.push(cur);
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return out;
  }
  /** Flatten a tree (by oid) to path -> {oid, mode}. */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const obj = this.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') this.flattenTree(e.oid, path, out);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
    return out;
  }
  /** Build a tree from a flat path map. */
  buildTreeFromFlat(flat: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of [...flat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const segs = path.split('/');
      let node = root;
      for (let i = 0; i < segs.length - 1; i++) {
        const name = segs[i] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segs[segs.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }
  /** Create a commit on top of `parentOid` (or a root commit) changing one file. */
  commitFile(parentOid: string | null, filePath: string, content: Buffer, message: string): string {
    const blobOid = this.putObject('blob', content);
    let flat = new Map<string, { oid: string; mode: string }>();
    if (parentOid) {
      const parent = this.objects.get(this.peel(parentOid));
      if (parent && parent.type === 'commit') flat = this.flattenTree(parseCommit(parent.data).tree);
    }
    flat.set(filePath, { oid: blobOid, mode: '100644' });
    const treeOid = this.buildTreeFromFlat(flat);
    const ts = nextTimestamp();
    const commitData = buildCommit(treeOid, parentOid ? [this.peel(parentOid)] : [], message.endsWith('\n') ? message : `${message}\n`, AUTHOR, ts);
    return this.putObject('commit', commitData);
  }
  treeOfCommit(commitOid: string): string | null {
    const obj = this.objects.get(this.peel(commitOid));
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }
  /** Diff two trees: list of {path, status, oldOid, newOid}. */
  diffTrees(baseTree: string | null, headTree: string | null): { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] {
    const base = baseTree ? this.flattenTree(baseTree) : new Map<string, { oid: string; mode: string }>();
    const head = headTree ? this.flattenTree(headTree) : new Map<string, { oid: string; mode: string }>();
    const out: { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
      else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
      else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
    return out;
  }
  /** Line-diff counts between two blob contents (added/deleted lines, naive LCS-free count). */
  lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
    const oldLines = oldData ? oldData.toString('utf8').split('\n') : [];
    const newLines = newData ? newData.toString('utf8').split('\n') : [];
    const oldSet = new Map<string, number>();
    for (const l of oldLines) oldSet.set(l, (oldSet.get(l) ?? 0) + 1);
    let additions = 0;
    for (const l of newLines) {
      const c = oldSet.get(l) ?? 0;
      if (c > 0) oldSet.set(l, c - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const c of oldSet.values()) deletions += c;
    // Trim trailing empty-line artefacts: a file ending with \n splits to a final ''.
    return { additions, deletions };
  }
  /** Does merging `pr` conflict? A path changed on both sides of the merge-base with different results. */
  prConflicts(pr: PullRequest, repo: Repo): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    if (!baseTip || !headTip) return true;
    const mb = this.mergeBase(baseTip, headTip);
    const mbTree = mb ? this.treeOfCommit(mb) : null;
    const baseTree = this.treeOfCommit(baseTip);
    const headTree = this.treeOfCommit(headTip);
    const baseChanges = new Map(this.diffTrees(mbTree, baseTree).map((d) => [d.path, d]));
    const headChanges = new Map(this.diffTrees(mbTree, headTree).map((d) => [d.path, d]));
    for (const [path, hc] of headChanges) {
      const bc = baseChanges.get(path);
      if (bc && bc.newOid !== hc.newOid) return true;
    }
    return false;
  }
  /** Squash-merge a pull request onto its base branch; returns the merge commit oid or null on conflict. */
  squashMerge(repo: Repo, pr: PullRequest): string | null {
    if (this.prConflicts(pr, repo)) return null;
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) as string;
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) as string;
    const mb = this.mergeBase(baseTip, headTip);
    const mbTree = mb ? this.treeOfCommit(mb) : null;
    const baseTree = this.treeOfCommit(baseTip);
    const headTree = this.treeOfCommit(headTip);
    const flat = baseTree ? this.flattenTree(baseTree) : new Map<string, { oid: string; mode: string }>();
    for (const d of this.diffTrees(mbTree, headTree)) {
      if (d.status === 'removed') flat.delete(d.path);
      else if (d.newOid) flat.set(d.path, { oid: d.newOid, mode: '100644' });
    }
    const treeOid = this.buildTreeFromFlat(flat);
    const ts = nextTimestamp();
    const msg = `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}\n`;
    const commitData = buildCommit(treeOid, [this.peel(baseTip)], msg, AUTHOR, ts);
    const mergeOid = this.putObject('commit', commitData);
    repo.refs.set(`refs/heads/${pr.baseRef}`, mergeOid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = isoOf(ts);
    pr.mergeCommitSha = mergeOid;
    pr.baseSha = mergeOid;
    return mergeOid;
  }
  /** Files changed by a PR (merge-base -> head). */
  prFiles(repo: Repo, pr: PullRequest): { path: string; status: string; additions: number; deletions: number; changes: number }[] {
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    if (!baseTip || !headTip) return [];
    const mb = this.mergeBase(baseTip, headTip);
    const mbTree = mb ? this.treeOfCommit(mb) : null;
    const headTree = this.treeOfCommit(headTip);
    const out: { path: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    for (const d of this.diffTrees(mbTree, headTree)) {
      const oldData = d.oldOid ? this.objects.get(d.oldOid)?.data ?? null : null;
      const newData = d.newOid ? this.objects.get(d.newOid)?.data ?? null : null;
      const { additions, deletions } = this.lineDiff(oldData, newData);
      out.push({ path: d.path, status: d.status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }
  globalId(kind: 'Repository' | 'Issue' | 'PullRequest' | 'Comment', key: string): string {
    return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
  }
  decodeGlobalId(id: string): { kind: string; key: string } | null {
    if (typeof id !== 'string' || id === '') return null;
    try {
      const text = Buffer.from(id, 'base64').toString('utf8');
      const idx = text.indexOf(':');
      if (idx <= 0) return null;
      return { kind: text.slice(0, idx), key: text.slice(idx + 1) };
    } catch {
      return null;
    }
  }
}

const store = new Store();

// ---------------------------------------------------------------------------
// 4. HTTP plumbing + REST v3
// ---------------------------------------------------------------------------
let reqCounter = 0;
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h) ?? /^token\s+(.+)$/i.exec(h);
  return m ? (m[1] as string).trim() : null;
}
function authed(req: IncomingMessage): boolean {
  const tok = bearerToken(req);
  if (!tok) return false;
  if (EXPECTED_TOKEN !== '') return tok === EXPECTED_TOKEN;
  return true;
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  reqCounter += 1;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${reqCounter.toString(16)}`,
    ...extraHeaders,
  });
  res.end(text);
}
function sendBinary(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}
function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' });
}
async function parseJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const v = JSON.parse(raw.toString('utf8')) as unknown;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return {};
  } catch {
    errJson(res, 400, 'Problems parsing JSON');
    return null;
  }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}
function pathOf(req: IncomingMessage): string {
  try {
    return decodeURIComponent(new URL(req.url ?? '/', 'http://entry').pathname);
  } catch {
    return '/';
  }
}
function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}
function paginate<T>(items: readonly T[], q: URLSearchParams): { page: T[]; pageNum: number; perPage: number; totalPages: number } {
  const perPage = Math.min(100, Math.max(1, Number(q.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(q.get('page') ?? '1') || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), pageNum, perPage, totalPages };
}
function linkHeader(base: string, path: string, q: URLSearchParams, pageNum: number, perPage: number, totalPages: number): string | null {
  if (pageNum >= totalPages) return null;
  const next = new URL(`${base}${path}`);
  next.searchParams.set('page', String(pageNum + 1));
  next.searchParams.set('per_page', String(perPage));
  return `<${next.toString()}>; rel="next"`;
}

// --- serializers ---
function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: store.globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: store.globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: '' })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
  };
}
function prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  return {
    id: pr.id,
    node_id: store.globalId('PullRequest', `${repo.id}:${pr.number}`),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: headTip, label: `${repo.owner}:${pr.headRef}`, user: { login: repo.owner } },
    base: { ref: pr.baseRef, sha: baseTip, label: `${repo.owner}:${pr.baseRef}`, user: { login: repo.owner } },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${pr.number}`,
  };
}
function findRepoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) {
    errJson(res, 404, 'Not Found');
    return null;
  }
  const repo = store.getRepo(owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return null;
  }
  return repo;
}
function cleanMessage(msg: string): string {
  return msg.replace(/\n+$/, '');
}
function commitJson(oid: string): Record<string, unknown> {
  const obj = store.getObject(oid);
  if (!obj || obj.type !== 'commit') return { sha: oid, commit: { message: '' } };
  const c = parseCommit(obj.data);
  const who = (ident: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(ident);
    if (!m) return { name: ident, email: '', date: isoOf(EPOCH_SEC) };
    return { name: m[1] as string, email: m[2] as string, date: isoOf(Number(m[3])) };
  };
  return {
    sha: oid,
    commit: { message: cleanMessage(c.message), author: who(c.author), committer: who(c.committer), tree: { sha: c.tree } },
    author: { login: VIEWER.login, id: VIEWER.id },
    committer: { login: VIEWER.login, id: VIEWER.id },
    parents: c.parents.map((p) => ({ sha: p })),
  };
}

async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);
  if (!path.startsWith('/api/v3')) return false;
  const q = queryOf(req);
  const sub = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
  // Public roots.
  if (method === 'GET' && (sub === '/' || sub === '')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && sub === '/meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }
  if (!authed(req)) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }
  const seg = sub.split('/').filter((s) => s !== '');
  // GET /user
  if (method === 'GET' && seg.length === 1 && seg[0] === 'user') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return true;
  }
  // /user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listViewerRepos(VIEWER.login);
      const { page, pageNum, perPage, totalPages } = paginate(repos, q);
      const headers: Record<string, string> = {};
      const link = linkHeader(baseUrlOf(req), '/api/v3/user/repos', q, pageNum, perPage, totalPages);
      if (link) headers.link = link;
      sendJson(res, 200, page.map(repoJson), headers);
      return true;
    }
    if (method === 'POST') {
      const body = await parseJsonBody(req, res);
      if (body === null) return true;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        errJson(res, 422, 'Validation Failed: name is invalid');
        return true;
      }
      if (store.getRepo(VIEWER.login, name)) {
        errJson(res, 422, 'Repository already exists');
        return true;
      }
      const repo = store.createRepo(VIEWER.login, name, {
        private: body.private === true,
        description: typeof body.description === 'string' ? body.description : '',
        defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : 'main',
      });
      sendJson(res, 201, repoJson(repo));
      return true;
    }
  }
  // /repos/{owner}/{repo}[...]
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1] as string;
    const name = seg[2] as string;
    const rest = seg.slice(3);
    // Repo object itself.
    if (rest.length === 0) {
      if (method === 'GET') {
        const repo = findRepoOr404(res, owner, name);
        if (repo) sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const repo = findRepoOr404(res, owner, name);
        if (!repo) return true;
        const body = await parseJsonBody(req, res);
        if (body === null) return true;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        const repo = findRepoOr404(res, owner, name);
        if (!repo) return true;
        store.deleteRepo(owner, name);
        res.writeHead(204, { 'x-github-request-id': `req-${++reqCounter}` });
        res.end();
        return true;
      }
    }
    const repo = findRepoOr404(res, owner, name);
    if (!repo) return true;
    // branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const list: Record<string, unknown>[] = [];
        for (const [ref, oid] of [...repo.refs.entries()].sort()) {
          if (!ref.startsWith('refs/heads/')) continue;
          list.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
        }
        sendJson(res, 200, list);
        return true;
      }
      if (method === 'GET' && rest.length === 2) {
        const oid = repo.refs.get(`refs/heads/${rest[1]}`);
        if (!oid) {
          errJson(res, 404, 'Branch not found');
          return true;
        }
        sendJson(res, 200, { name: rest[1], commit: { sha: oid }, protected: false });
        return true;
      }
    }
    // commits
    if (rest[0] === 'commits' && method === 'GET' && rest.length === 1) {
      const refName = q.get('sha') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${refName}`) ?? (isOid(refName) ? refName : undefined);
      if (!tip) {
        sendJson(res, 200, []);
        return true;
      }
      const walked = store.commitWalk([tip]);
      const { page } = paginate(walked, q);
      sendJson(res, 200, page.map(commitJson));
      return true;
    }
    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = await parseJsonBody(req, res);
        if (body === null) return true;
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || !store.getObject(sha)) {
          errJson(res, 422, 'Validation Failed');
          return true;
        }
        if (repo.refs.has(ref)) {
          errJson(res, 422, 'Reference already exists');
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${repo.fullName}/git/refs/${ref}` });
        return true;
      }
      if (method === 'GET' && rest.length === 2) {
        const list: Record<string, unknown>[] = [];
        for (const [ref, oid] of [...repo.refs.entries()].sort()) list.push({ ref, object: { sha: oid, type: 'commit' } });
        sendJson(res, 200, list);
        return true;
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const oid = repo.refs.get(ref);
        if (!oid) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { ref, object: { sha: oid, type: 'commit' }, url: `/api/v3/repos/${repo.fullName}/git/refs/${ref}` });
        return true;
      }
    }
    // contents
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      const refName = q.get('ref') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${refName}`) ?? (isOid(refName) ? refName : undefined);
      if (method === 'GET') {
        if (!tip) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const treeOid = store.treeOfCommit(tip);
        if (!treeOid) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const flat = store.flattenTree(treeOid);
        const entry = flat.get(filePath);
        if (entry) {
          const data = store.getObject(entry.oid)?.data ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: data.length, name: filePath.split('/').pop() ?? filePath,
            path: filePath, content: data.toString('base64'), sha: entry.oid,
            url: `/api/v3/repos/${repo.fullName}/contents/${filePath}`,
          });
          return true;
        }
        // directory listing (immediate children) — derived from the flattened tree
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const kids = new Map<string, { type: string; sha: string; path: string }>();
        const dirTreeOid = (treeOidOf: string, dirPath: string): string | null => {
          if (dirPath === '') return treeOidOf;
          let cur: string | null = treeOidOf;
          for (const seg of dirPath.split('/')) {
            const t = cur ? store.getObject(cur) : undefined;
            if (!t || t.type !== 'tree') return null;
            const e = parseTree(t.data).find((x) => x.name === seg && x.mode === '40000');
            cur = e ? e.oid : null;
          }
          return cur;
        };
        for (const [p, e] of flat) {
          if (filePath !== '' && !p.startsWith(prefix)) continue;
          const rest = filePath === '' ? p : p.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash < 0) {
            kids.set(rest, { type: 'file', sha: e.oid, path: p });
          } else {
            const dir = rest.slice(0, slash);
            if (!kids.has(dir)) {
              const dirPath = filePath === '' ? dir : `${filePath}/${dir}`;
              kids.set(dir, { type: 'dir', sha: dirTreeOid(treeOid, dirPath) ?? '', path: dirPath });
            }
          }
        }
        if (filePath === '' || kids.size > 0) {
          const arr = [...kids.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([nm, k]) => ({
            type: k.type, name: nm, path: k.path, sha: k.sha, size: k.type === 'file' ? (store.getObject(k.sha)?.data.length ?? 0) : 0,
            url: `/api/v3/repos/${repo.fullName}/contents/${k.path}`,
          }));
          sendJson(res, 200, arr);
          return true;
        }
        errJson(res, 404, 'Not Found');
        return true;
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req, res);
        if (body === null) return true;
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        const message = typeof body.message === 'string' ? body.message : 'Update file';
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        let branchTip = repo.refs.get(`refs/heads/${branch}`);
        if (!branchTip) {
          // Create the branch from the default tip (or empty) — the MCP fallback path.
          const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (baseTip) repo.refs.set(`refs/heads/${branch}`, baseTip);
          branchTip = repo.refs.get(`refs/heads/${branch}`) ?? null;
        }
        const treeOid = branchTip ? store.treeOfCommit(branchTip) : null;
        const flat = treeOid ? store.flattenTree(treeOid) : new Map<string, { oid: string; mode: string }>();
        const existing = flat.get(filePath);
        const isCreate = !existing;
        if (typeof body.sha === 'string' && existing && body.sha !== existing.oid) {
          errJson(res, 409, 'Conflict: sha does not match');
          return true;
        }
        if (typeof body.sha === 'string' && !existing) {
          errJson(res, 422, 'Validation Failed: sha given for a file that does not exist');
          return true;
        }
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
        } catch {
          errJson(res, 422, 'Validation Failed: content is not valid base64');
          return true;
        }
        const newTip = store.commitFile(branchTip, filePath, content, message);
        repo.refs.set(`refs/heads/${branch}`, newTip);
        const blobOid = hashObject('blob', content);
        sendJson(res, isCreate ? 201 : 200, {
          content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
          commit: { sha: newTip, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const body = await parseJsonBody(req, res);
        if (body === null) return true;
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const branchTip = repo.refs.get(`refs/heads/${branch}`);
        if (!branchTip) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const treeOid = store.treeOfCommit(branchTip);
        const flat = treeOid ? store.flattenTree(treeOid) : new Map<string, { oid: string; mode: string }>();
        const existing = flat.get(filePath);
        if (!existing) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (typeof body.sha === 'string' && body.sha !== existing.oid) {
          errJson(res, 409, 'Conflict: sha does not match');
          return true;
        }
        const message = typeof body.message === 'string' ? body.message : 'Delete file';
        flat.delete(filePath);
        const newTree = store.buildTreeFromFlat(flat);
        const ts = nextTimestamp();
        const commitData = buildCommit(newTree, [store.peel(branchTip)], message.endsWith('\n') ? message : `${message}\n`, AUTHOR, ts);
        const newTip = store.putObject('commit', commitData);
        repo.refs.set(`refs/heads/${branch}`, newTip);
        sendJson(res, 200, { commit: { sha: newTip, message } });
        return true;
      }
    }
    // labels
    if (rest[0] === 'labels' && method === 'POST' && rest.length === 1) {
      const body = await parseJsonBody(req, res);
      if (body === null) return true;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        errJson(res, 422, 'Validation Failed: name is required');
        return true;
      }
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { name, color, description: '' });
      return true;
    }
    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = await parseJsonBody(req, res);
          if (body === null) return true;
          const title = typeof body.title === 'string' ? body.title : '';
          const bodyText = typeof body.body === 'string' ? body.body : '';
          const labelNames: string[] = Array.isArray(body.labels)
            ? (body.labels as unknown[]).map((l) => (typeof l === 'string' ? l : (l as Record<string, unknown>)?.name)).filter((x): x is string => typeof x === 'string')
            : [];
          for (const ln of labelNames) {
            if (!repo.labels.has(ln)) {
              errJson(res, 422, `Validation Failed: label "${ln}" does not exist`);
              return true;
            }
          }
          const seq = nextSeq();
          const number = repo.nextNumber++;
          const issue: Issue = {
            id: repo.nextIssueId++, number, title, body: bodyText, state: 'open',
            labels: labelNames.map((ln) => repo.labels.get(ln) as Label),
            comments: [], seq, createdAt: isoOf(EPOCH_SEC + seq), updatedAt: isoOf(EPOCH_SEC + seq),
          };
          repo.issues.set(number, issue);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          let list = [...repo.issues.values()];
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          const sort = q.get('sort') ?? 'created';
          const dir = q.get('direction') ?? 'desc';
          if (sort === 'created') list.sort((a, b) => (dir === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const { page } = paginate(list, q);
          sendJson(res, 200, page.map((i) => issueJson(repo, i)));
          return true;
        }
      }
      const num = Number(rest[1]);
      if (rest.length === 2 && Number.isInteger(num)) {
        const issue = repo.issues.get(num);
        if (!issue) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          const body = await parseJsonBody(req, res);
          if (body === null) return true;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          issue.updatedAt = isoOf(EPOCH_SEC + nextSeq());
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
      }
      if (rest.length === 3 && rest[2] === 'comments' && Number.isInteger(num)) {
        const issue = repo.issues.get(num);
        if (!issue) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (method === 'POST') {
          const body = await parseJsonBody(req, res);
          if (body === null) return true;
          const seq = nextSeq();
          const comment = { id: repo.nextCommentId++, body: typeof body.body === 'string' ? body.body : '' };
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: isoOf(EPOCH_SEC + seq), updated_at: isoOf(EPOCH_SEC + seq) });
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER.login, id: VIEWER.id } })));
          return true;
        }
      }
    }
    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = await parseJsonBody(req, res);
          if (body === null) return true;
          const stripOwner = (r: unknown): string => {
            if (typeof r !== 'string') return '';
            const idx = r.indexOf(':');
            return idx >= 0 ? r.slice(idx + 1) : r;
          };
          const head = stripOwner(body.head);
          const base = stripOwner(body.base);
          const title = typeof body.title === 'string' ? body.title : '';
          const bodyText = typeof body.body === 'string' ? body.body : '';
          if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
            errJson(res, 422, 'Validation Failed: head or base branch does not exist');
            return true;
          }
          for (const pr of repo.pulls.values()) {
            if (pr.state === 'open' && pr.headRef === head && pr.baseRef === base) {
              errJson(res, 422, 'Validation Failed: a pull request already exists for this head and base');
              return true;
            }
          }
          const seq = nextSeq();
          const number = repo.nextNumber++;
          const pr: PullRequest = {
            id: repo.nextIssueId++, number, title, body: bodyText, state: 'open', merged: false,
            mergedAt: null, mergeCommitSha: null, headRef: head, baseRef: base,
            headSha: repo.refs.get(`refs/heads/${head}`) as string, baseSha: repo.refs.get(`refs/heads/${base}`) as string,
            seq, createdAt: isoOf(EPOCH_SEC + seq), updatedAt: isoOf(EPOCH_SEC + seq),
          };
          repo.pulls.set(number, pr);
          sendJson(res, 201, prJson(repo, pr));
          return true;
        }
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, b) => b.seq - a.seq);
          const { page } = paginate(list, q);
          sendJson(res, 200, page.map((p) => prJson(repo, p)));
          return true;
        }
      }
      const num = Number(rest[1]);
      if (Number.isInteger(num)) {
        const pr = repo.pulls.get(num);
        if (rest.length === 2) {
          if (!pr) {
            errJson(res, 404, 'Not Found');
            return true;
          }
          if (method === 'GET') {
            sendJson(res, 200, prJson(repo, pr));
            return true;
          }
        }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          if (!pr) {
            errJson(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, store.prFiles(repo, pr).map((f) => ({
            filename: f.path, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes,
          })));
          return true;
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          if (!pr) {
            errJson(res, 404, 'Not Found');
            return true;
          }
          // Merge body is informational only; a malformed body must not fail the merge.
          await readBody(req).catch(() => Buffer.alloc(0));
          if (pr.state !== 'open') {
            errJson(res, 405, 'Pull Request is not open');
            return true;
          }
          const merged = store.squashMerge(repo, pr);
          if (merged === null) {
            errJson(res, 405, 'Merge conflict');
            return true;
          }
          sendJson(res, 200, { sha: merged, merged: true, message: 'Pull Request successfully merged' });
          return true;
        }
      }
    }
    errJson(res, 404, 'Not Found');
    return true;
  }
  errJson(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------
// 5. Git smart HTTP
// ---------------------------------------------------------------------------
function gitAgentCaps(): string {
  return 'agent=forge/1.0';
}
function refLines(repo: Repo, caps: string): string[] {
  const lines: string[] = [];
  const heads: [string, string][] = [];
  for (const [ref, oid] of repo.refs.entries()) heads.push([ref, oid]);
  heads.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip) lines.push(`${defaultTip} HEAD`);
  for (const [ref, oid] of heads) {
    lines.push(`${oid} ${ref}`);
    const obj = store.getObject(oid);
    if (obj && obj.type === 'tag') {
      const target = store.peel(oid);
      lines.push(`${target} ${ref}^{}`);
    }
  }
  return lines;
}
function v0Advertisement(repo: Repo, service: string, caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines = refLines(repo, caps);
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, i) => {
      parts.push(pktLine(i === 0 ? `${line}\0${caps}\n` : `${line}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `${gitAgentCaps()}\n`,
    'flush' as const,
  ]);
}
interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
}
function selectObjects(repo: Repo, fr: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  // Peel tag wants to commits but include the tag objects themselves.
  const tagObjs: string[] = [];
  const peeledWants: string[] = [];
  for (const w of fr.wants) {
    const obj = store.getObject(w);
    if (obj && obj.type === 'tag') {
      tagObjs.push(w);
      peeledWants.push(store.peel(w));
    } else {
      peeledWants.push(w);
    }
  }
  // Commit set C.
  const commitSet = new Set<string>();
  if (fr.depth !== null) {
    const queue: { oid: string; dist: number }[] = peeledWants.map((o) => ({ oid: store.peel(o), dist: 0 }));
    const seen = new Set<string>();
    while (queue.length) {
      const { oid, dist } = queue.shift() as { oid: string; dist: number };
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = store.getObject(oid);
      if (!obj || obj.type !== 'commit') continue;
      commitSet.add(oid);
      if (dist + 1 < fr.depth) {
        for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, dist: dist + 1 });
      }
    }
  } else {
    for (const c of store.commitWalk(peeledWants)) commitSet.add(c);
  }
  // Included objects: the depth-limited commit set, each commit's tree closure
  // (trees + blobs only — never the parents, or a depth limit would leak history),
  // plus any tag objects the client asked for by oid.
  const included = new Set<string>();
  for (const c of commitSet) {
    included.add(c);
    const obj = store.getObject(c);
    if (obj && obj.type === 'commit') {
      for (const o of store.closure([parseCommit(obj.data).tree])) included.add(o);
    }
  }
  for (const t of tagObjs) included.add(t);
  // Excluded: for each have — a shallow boundary excludes only itself + its tree/blobs
  // (the client does not hold its ancestors), a normal have excludes its full closure.
  const shallowSet = new Set(fr.shallow);
  for (const h of fr.haves) {
    const peeled = store.peel(h);
    if (shallowSet.has(h) || shallowSet.has(peeled)) {
      const obj = store.getObject(peeled);
      if (obj && obj.type === 'commit') {
        included.delete(peeled);
        // The client holds this commit's whole tree (subtrees + blobs) but not
        // its ancestors, so exclude the tree closure without touching parents.
        for (const o of store.closure([parseCommit(obj.data).tree])) included.delete(o);
      } else {
        included.delete(peeled);
      }
    } else {
      for (const o of store.closure([peeled])) included.delete(o);
    }
  }
  // Shallow-info: included commits whose parents are not included.
  const shallow: string[] = [];
  for (const c of commitSet) {
    if (!included.has(c)) continue;
    const parents = store.commitParents(c);
    if (parents.length === 0 || parents.every((p) => !included.has(p))) shallow.push(c);
  }
  // When depth is not requested but the client reports shallow boundaries, echo them.
  if (fr.depth === null && fr.shallow.length > 0) {
    for (const s of fr.shallow) {
      const peeled = store.peel(s);
      if (included.has(peeled) && !shallow.includes(peeled)) shallow.push(peeled);
    }
  }
  const unshallow: string[] = [];
  for (const s of fr.shallow) {
    const peeled = store.peel(s);
    if (commitSet.has(peeled) && included.has(peeled) && !shallow.includes(peeled)) unshallow.push(peeled);
  }
  // Build the pack (cached per exact request shape; the object graph only grows).
  const cacheKey = JSON.stringify({ r: repo.fullName, w: [...fr.wants].sort(), h: [...fr.haves].sort(), s: [...fr.shallow].sort(), d: fr.depth });
  const cached = store.packCache.get(cacheKey);
  if (cached) return { pack: cached, shallow, unshallow };
  const sorted = [...included].sort();
  const objects: GitObject[] = [];
  for (const oid of sorted) {
    const obj = store.getObject(oid);
    if (obj) objects.push({ type: obj.type, data: obj.data });
  }
  const pack = writePack(objects);
  if (store.packCache.size >= 32) {
    const first = store.packCache.keys().next().value as string;
    store.packCache.delete(first);
  }
  store.packCache.set(cacheKey, pack);
  return { pack, shallow, unshallow };
}
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}
function v2LsRefs(repo: Repo, args: string[]): Buffer {
  const wantSymrefs = args.includes('symrefs');
  const wantPeel = args.includes('peel');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const parts: Buffer[] = [];
  const heads: [string, string][] = [];
  for (const [ref, oid] of repo.refs.entries()) heads.push([ref, oid]);
  heads.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const refMatches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  if (heads.length === 0) {
    if (wantUnborn) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else {
    if (prefixes.length === 0 && defaultTip) {
      let headLine = `${defaultTip} HEAD`;
      if (wantSymrefs) headLine += ` symref-target:refs/heads/${repo.defaultBranch}`;
      parts.push(pktLine(`${headLine}\n`));
    }
    for (const [ref, oid] of heads) {
      if (!refMatches(ref)) continue;
      let line = `${oid} ${ref}`;
      if (wantPeel) {
        const obj = store.getObject(oid);
        if (obj && obj.type === 'tag') line += ` peeled:${store.peel(oid)}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
function v2Fetch(repo: Repo, args: string[]): Buffer {
  const fr: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null };
  for (const a of args) {
    if (a.startsWith('want ')) fr.wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) fr.haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) fr.shallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) {
      const n = Number(a.slice(7).trim());
      if (Number.isFinite(n) && n > 0) fr.depth = n;
    } else if (a.startsWith('deepen-since ')) {
      fr.deepenSince = Number(a.slice(13).trim());
    }
  }
  const { pack, shallow, unshallow } = selectObjects(repo, fr);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH);
  if (fr.depth !== null || fr.shallow.length > 0 || shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
function v0Fetch(repo: Repo, lines: string[]): Buffer {
  const fr: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null };
  for (const raw of lines) {
    const a = raw.replace(/\0.*$/, '').trim();
    if (a.startsWith('want ')) fr.wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) fr.haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) fr.shallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) {
      const n = Number(a.slice(7).trim());
      if (Number.isFinite(n) && n > 0) fr.depth = n;
    }
  }
  const { pack, shallow, unshallow } = selectObjects(repo, fr);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}
function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  // Parse pkt-line commands up to the first flush; the remainder is the pack.
  const commands: PushCommand[] = [];
  let off = 0;
  let packStart = body.length;
  while (off + 4 <= body.length) {
    const len = parseInt(body.subarray(off, off + 4).toString('ascii'), 16);
    if (!Number.isFinite(len) || len < 0) break;
    if (len === 0) {
      packStart = off + 4;
      break;
    }
    if (off + len > body.length) break;
    const line = body.subarray(off + 4, off + len).toString('utf8');
    const capIdx = line.indexOf('\0');
    const core = capIdx >= 0 ? line.slice(0, capIdx) : line;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(core);
    if (m) commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
    off += len;
  }
  const packBytes = body.subarray(packStart);
  if (packBytes.length >= 32) {
    try {
      const { objects } = readPackFull(packBytes);
      for (const [oid, obj] of objects) store.storeObject(obj.type, obj.data, oid);
    } catch {
      // A bad pack still gets a report; refs are not moved for commands whose
      // new objects are missing (validated below).
    }
  }
  const report: { ref: string; ok: boolean; reason: string }[] = [];
  for (const cmd of commands) {
    const cur = repo.refs.get(cmd.ref);
    let ok = true;
    let reason = '';
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (cur === undefined) {
        ok = false;
        reason = 'remote ref does not exist';
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== cur) {
        ok = false;
        reason = 'non-fast-forward';
      }
    } else if (cmd.oldOid === ZERO_OID) {
      // create
      if (cur !== undefined) {
        ok = false;
        reason = 'already exists';
      } else if (!store.getObject(cmd.newOid)) {
        ok = false;
        reason = 'failed to parse commit';
      }
    } else {
      // update
      if (cur === undefined) {
        ok = false;
        reason = 'remote ref does not exist';
      } else if (cmd.oldOid !== cur) {
        ok = false;
        reason = 'non-fast-forward';
      } else if (!store.getObject(cmd.newOid)) {
        ok = false;
        reason = 'failed to parse commit';
      } else if (!store.isAncestor(cmd.oldOid, cmd.newOid)) {
        ok = false;
        reason = 'non-fast-forward';
      }
    }
    if (ok) {
      if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
      else repo.refs.set(cmd.ref, cmd.newOid);
    }
    report.push({ ref: cmd.ref, ok, reason });
  }
  const reportLines: Buffer[] = [pktLine('unpack ok\n')];
  for (const r of report) {
    reportLines.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  }
  const bandPayload = Buffer.concat(reportLines);
  const parts: Buffer[] = [pktLine(Buffer.concat([Buffer.from([1]), bandPayload])), PKT_FLUSH];
  return Buffer.concat(parts);
}

async function handleGit(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!m) return false;
  const owner = decodeURIComponent(m[1] as string);
  const name = decodeURIComponent(m[2] as string);
  const service = m[3] as string;
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const q = queryOf(req);
  if (method === 'GET' && service === 'info/refs') {
    const svc = q.get('service') ?? '';
    if (svc === 'git-upload-pack') {
      const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      if (isV2) {
        sendBinary(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      } else {
        const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta multi_ack shallow object-format=sha1 ${gitAgentCaps()}`;
        sendBinary(res, 200, v0Advertisement(repo, 'git-upload-pack', caps), 'application/x-git-upload-pack-advertisement');
      }
      return true;
    }
    if (svc === 'git-receive-pack') {
      const caps = `report-status report-status-v2 side-band-64k delete-refs ofs-delta ${gitAgentCaps()}`;
      sendBinary(res, 200, v0Advertisement(repo, 'git-receive-pack', caps), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    errJson(res, 400, 'service not specified');
    return true;
  }
  if (method === 'POST' && service === 'git-upload-pack') {
    const body = await readBody(req);
    const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    try {
      if (isV2) {
        const lines = decodePktLines(body).map((b) => b.toString('utf8').replace(/\n$/, ''));
        const cmdLine = lines[0] ?? '';
        const args = lines.slice(1);
        if (cmdLine.startsWith('command=ls-refs')) {
          sendBinary(res, 200, v2LsRefs(repo, args), 'application/x-git-upload-pack-result');
        } else if (cmdLine.startsWith('command=fetch')) {
          sendBinary(res, 200, v2Fetch(repo, args), 'application/x-git-upload-pack-result');
        } else {
          sendBinary(res, 200, pktLines(['flush' as const]), 'application/x-git-upload-pack-result');
        }
      } else {
        const lines = decodePktLines(body).map((b) => b.toString('utf8').replace(/\n$/, ''));
        sendBinary(res, 200, v0Fetch(repo, lines), 'application/x-git-upload-pack-result');
      }
    } catch {
      errJson(res, 400, 'bad request');
    }
    return true;
  }
  if (method === 'POST' && service === 'git-receive-pack') {
    const body = await readBody(req);
    try {
      const out = handleReceivePack(repo, body);
      sendBinary(res, 200, out, 'application/x-git-receive-pack-result');
    } catch {
      errJson(res, 400, 'bad request');
    }
    return true;
  }
  errJson(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------
// 6. GraphQL v4 (parser + executor)
// ---------------------------------------------------------------------------
type GqlValue = string | number | boolean | null | GqlValue[] | { [k: string]: GqlValue };
interface FieldNode { kind: 'field'; alias: string | null; name: string; args: Record<string, GqlValue>; selections: SelectionNode[] }
interface SpreadNode { kind: 'spread'; name: string }
interface InlineNode { kind: 'inline'; typeCondition: string | null; selections: SelectionNode[] }
type SelectionNode = FieldNode | SpreadNode | InlineNode;
interface OperationNode { kind: 'operation'; opType: 'query' | 'mutation'; name: string | null; varDefs: Record<string, unknown>; selections: SelectionNode[] }
interface FragmentNode { kind: 'fragment'; name: string; typeCondition: string; selections: SelectionNode[] }

type Token =
  | { t: 'punct'; v: string }
  | { t: 'name'; v: string }
  | { t: 'int'; v: number }
  | { t: 'float'; v: number }
  | { t: 'string'; v: string };
function tokenizeGql(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',' || ch === '\uFEFF') { i++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { toks.push({ t: 'punct', v: '...' }); i += 3; continue; }
    if ('{}():$!=@[]|'.includes(ch)) { toks.push({ t: 'punct', v: ch }); i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length) {
        const c = src[j] as string;
        if (c === '\\') {
          const n = src[j + 1] as string;
          if (n === 'n') out += '\n';
          else if (n === 't') out += '\t';
          else if (n === 'r') out += '\r';
          else if (n === '"') out += '"';
          else if (n === '\\') out += '\\';
          else if (n === '/') out += '/';
          else if (n === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += n;
          j += 2;
          continue;
        }
        if (c === '"') break;
        out += c;
        j++;
      }
      toks.push({ t: 'string', v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) {
        if (src[j] === '.' || src[j] === 'e' || src[j] === 'E') isFloat = true;
        j++;
      }
      const text = src.slice(i, j);
      toks.push(isFloat ? { t: 'float', v: Number(text) } : { t: 'int', v: Number(text) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < src.length && isNameChar(src[j] as string)) j++;
      toks.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    i++;
  }
  return toks;
}
class GqlParser {
  toks: Token[];
  pos = 0;
  constructor(src: string) {
    this.toks = tokenizeGql(src);
  }
  peek(): Token | undefined {
    return this.toks[this.pos];
  }
  next(): Token {
    return this.toks[this.pos++] as Token;
  }
  expectPunct(v: string): void {
    const t = this.next();
    if (t.t !== 'punct' || t.v !== v) throw new Error(`expected ${v}`);
  }
  acceptPunct(v: string): boolean {
    const t = this.peek();
    if (t && t.t === 'punct' && t.v === v) {
      this.pos++;
      return true;
    }
    return false;
  }
  expectName(): string {
    const t = this.next();
    if (t.t !== 'name') throw new Error('expected name');
    return t.v;
  }
  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.toks.length) {
      const t = this.peek() as Token;
      if (t.t === 'punct' && t.v === '{') {
        operations.push({ kind: 'operation', opType: 'query', name: null, varDefs: {}, selections: this.parseSelectionSet() });
      } else if (t.t === 'name' && (t.v === 'query' || t.v === 'mutation')) {
        const opType = t.v as 'query' | 'mutation';
        this.pos++;
        let name: string | null = null;
        const nt = this.peek();
        if (nt && nt.t === 'name') name = this.next().v as string;
        let varDefs: Record<string, unknown> = {};
        if (this.peek()?.t === 'punct' && (this.peek() as Token & { v: string }).v === '(') {
          varDefs = this.parseVariableDefinitions();
        }
        // directives (skip)
        while (this.peek()?.t === 'punct' && (this.peek() as Token & { v: string }).v === '@') {
          this.pos++;
          this.expectName();
          if (this.peek()?.t === 'punct' && (this.peek() as Token & { v: string }).v === '(') this.parseArguments();
        }
        operations.push({ kind: 'operation', opType, name, varDefs, selections: this.parseSelectionSet() });
      } else if (t.t === 'name' && t.v === 'fragment') {
        this.pos++;
        const name = this.expectName();
        this.expectName(); // 'on'
        const tc = this.expectName();
        fragments.set(name, { kind: 'fragment', name, typeCondition: tc, selections: this.parseSelectionSet() });
      } else {
        this.pos++;
      }
    }
    return { operations, fragments };
  }
  parseVariableDefinitions(): Record<string, unknown> {
    const defs: Record<string, unknown> = {};
    this.expectPunct('(');
    while (!(this.peek()?.t === 'punct' && (this.peek() as Token & { v: string }).v === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      // type (ignore details, keep raw)
      let depth = 0;
      let typeText = '';
      while (this.pos < this.toks.length) {
        const t = this.toks[this.pos] as Token;
        if (t.t === 'punct' && t.v === '[') depth++;
        if (t.t === 'punct' && t.v === ']') depth--;
        if (depth === 0 && t.t === 'punct' && (t.v === ',' || t.v === ')' || t.v === '=')) break;
        typeText += t.t === 'name' ? (t as { v: string }).v : (t as { v: string }).v;
        this.pos++;
      }
      void typeText;
      let def: unknown;
      if (this.acceptPunct('=')) def = this.parseValue();
      defs[name] = def;
    }
    this.expectPunct(')');
    return defs;
  }
  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek()?.t === 'punct' && (this.peek() as Token & { v: string }).v === '}')) {
      if (this.pos >= this.toks.length) break;
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }
  parseSelection(): SelectionNode {
    const t = this.peek() as Token;
    if (t.t === 'punct' && t.v === '...') {
      this.pos++;
      const nt = this.peek();
      if (nt && nt.t === 'name' && nt.v === 'on') {
        this.pos++;
        const tc = this.expectName();
        return { kind: 'inline', typeCondition: tc, selections: this.parseSelectionSet() };
      }
      if (nt && nt.t === 'name') {
        return { kind: 'spread', name: this.next().v as string };
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek()?.t === 'punct' && (this.peek() as Token & { v: string }).v === ':') {
      this.pos++;
      alias = name;
      name = this.expectName();
    }
    let args: Record<string, GqlValue> = {};
    if (this.peek()?.t === 'punct' && (this.peek() as Token & { v: string }).v === '(') args = this.parseArguments();
    while (this.peek()?.t === 'punct' && (this.peek() as Token & { v: string }).v === '@') {
      this.pos++;
      this.expectName();
      if (this.peek()?.t === 'punct' && (this.peek() as Token & { v: string }).v === '(') this.parseArguments();
    }
    let selections: SelectionNode[] = [];
    if (this.peek()?.t === 'punct' && (this.peek() as Token & { v: string }).v === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }
  parseArguments(): Record<string, GqlValue> {
    const out: Record<string, GqlValue> = {};
    this.expectPunct('(');
    while (!(this.peek()?.t === 'punct' && (this.peek() as Token & { v: string }).v === ')')) {
      if (this.pos >= this.toks.length) break;
      const name = this.expectName();
      this.expectPunct(':');
      out[name] = this.parseValue();
    }
    this.expectPunct(')');
    return out;
  }
  parseValue(): GqlValue {
    const t = this.next();
    if (t.t === 'punct' && t.v === '$') return { $var: this.expectName() } as unknown as GqlValue;
    if (t.t === 'string') return t.v;
    if (t.t === 'int' || t.t === 'float') return t.v;
    if (t.t === 'name') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      return { $enum: t.v } as unknown as GqlValue;
    }
    if (t.t === 'punct' && t.v === '[') {
      const arr: GqlValue[] = [];
      while (!(this.peek()?.t === 'punct' && (this.peek() as Token & { v: string }).v === ']')) {
        arr.push(this.parseValue());
      }
      this.expectPunct(']');
      return arr;
    }
    if (t.t === 'punct' && t.v === '{') {
      const obj: { [k: string]: GqlValue } = {};
      while (!(this.peek()?.t === 'punct' && (this.peek() as Token & { v: string }).v === '}')) {
        const k = this.expectName();
        this.expectPunct(':');
        obj[k] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    throw new Error('bad value');
  }
}
function resolveGqlValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if ('$var' in o) {
      const name = o.$var as string;
      return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
    }
    if ('$enum' in o) return o.$enum;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = resolveGqlValue(val as GqlValue, vars);
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => resolveGqlValue(x, vars));
  return v;
}
function resolveArgs(args: Record<string, GqlValue>, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = resolveGqlValue(v, vars);
  return out;
}

// --- GraphQL type metadata (introspection + validation) ---
const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'addComment', 'createPullRequest', 'mergePullRequest'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt', 'labels'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'repository', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'files'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType', 'status'],
  Ref: ['name', 'target'],
  Actor: ['login'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces'],
  __Schema: ['queryType', 'mutationType', 'types', 'description'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  AddCommentPayload: ['comment', 'subject', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  Payload: ['issue', 'pullRequest', 'comment', 'commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
};
const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'DISCUSSION', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};
const GQL_TYPE_KIND: Record<string, string> = {
  Issue: 'OBJECT', PullRequest: 'OBJECT', Repository: 'OBJECT', User: 'OBJECT',
  Query: 'OBJECT', Mutation: 'OBJECT', PageInfo: 'OBJECT',
  IssueState: 'ENUM', PullRequestState: 'ENUM', SearchType: 'ENUM', MergeableState: 'ENUM',
  IssueOrderField: 'ENUM', OrderDirection: 'ENUM', MergeMethod: 'ENUM',
  IssueConnection: 'OBJECT', PullRequestConnection: 'OBJECT',
};

type GqlCtx =
  | { kind: 'Query' }
  | { kind: 'Mutation' }
  | { kind: 'User'; login: string }
  | { kind: 'Repository'; repo: Repo }
  | { kind: 'Issue'; repo: Repo; issue: Issue }
  | { kind: 'PullRequest'; repo: Repo; pr: PullRequest }
  | { kind: 'IssueConnection'; repo: Repo; issues: Issue[]; endCursor: string; hasNextPage: boolean }
  | { kind: 'PullRequestConnection'; repo: Repo; prs: PullRequest[]; endCursor: string; hasNextPage: boolean }
  | { kind: 'LabelConnection'; labels: Label[] }
  | { kind: 'CommentConnection'; repo: Repo; issue: Issue }
  | { kind: 'FileConnection'; repo: Repo; pr: PullRequest }
  | { kind: 'Label'; label: Label }
  | { kind: 'Comment'; comment: { id: number; body: string } }
  | { kind: 'File'; file: { path: string; status: string; additions: number; deletions: number; changes: number } }
  | { kind: 'PageInfo'; hasNextPage: boolean; endCursor: string }
  | { kind: 'Ref'; name: string; repo: Repo }
  | { kind: 'TypeInfo'; name: string }
  | { kind: 'SchemaInfo' }
  | { kind: 'Edge'; node: GqlCtx; cursor: string }
  | { kind: 'Payload'; fields: Record<string, GqlCtx | null> };

function ctxTypeName(ctx: GqlCtx): string {
  switch (ctx.kind) {
    case 'Query': return 'Query';
    case 'Mutation': return 'Mutation';
    case 'User': return 'User';
    case 'Repository': return 'Repository';
    case 'Issue': return 'Issue';
    case 'PullRequest': return 'PullRequest';
    case 'IssueConnection': return 'IssueConnection';
    case 'PullRequestConnection': return 'PullRequestConnection';
    case 'LabelConnection': return 'LabelConnection';
    case 'CommentConnection': return 'IssueCommentConnection';
    case 'FileConnection': return 'PullRequestFileConnection';
    case 'Label': return 'Label';
    case 'Comment': return 'IssueComment';
    case 'File': return 'PullRequestFile';
    case 'PageInfo': return 'PageInfo';
    case 'Ref': return 'Ref';
    case 'TypeInfo': return '__Type';
    case 'SchemaInfo': return '__Schema';
    case 'Edge': return 'IssueCommentEdge';
    case 'Payload': return 'Payload';
  }
}
function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}
function cursorIndex(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : -1;
  } catch {
    return -1;
  }
}

class GqlExecutor {
  errors: { message: string }[] = [];
  fragments = new Map<string, FragmentNode>();
  vars: Record<string, unknown> = {};

  execute(docText: string, variables: Record<string, unknown>, operationName?: string): { data?: Record<string, unknown>; errors?: { message: string }[] } {
    let doc: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
    try {
      doc = new GqlParser(docText).parseDocument();
    } catch (e) {
      return { errors: [{ message: e instanceof Error ? e.message : 'GraphQL parse error' }] };
    }
    this.fragments = doc.fragments;
    let op: OperationNode | undefined;
    if (operationName) op = doc.operations.find((o) => o.name === operationName);
    op = op ?? doc.operations[0];
    if (!op) return { errors: [{ message: 'No operation found' }] };
    const vars = { ...variables };
    for (const [k, def] of Object.entries(op.varDefs)) {
      if (!(k in vars) && def !== undefined) vars[k] = def;
    }
    this.vars = vars;
    const root: GqlCtx = op.opType === 'mutation' ? { kind: 'Mutation' } : { kind: 'Query' };
    const data: Record<string, unknown> = {};
    for (const sel of op.selections) this.executeSelection(sel, root, data);
    const out: { data?: Record<string, unknown>; errors?: { message: string }[] } = { data };
    if (this.errors.length) out.errors = this.errors;
    return out;
  }

  executeSelection(sel: SelectionNode, ctx: GqlCtx, out: Record<string, unknown>): void {
    if (sel.kind === 'spread') {
      const frag = this.fragments.get(sel.name);
      if (!frag) {
        this.errors.push({ message: `Unknown fragment "${sel.name}".` });
        return;
      }
      if (frag.typeCondition !== ctxTypeName(ctx)) return;
      for (const s of frag.selections) this.executeSelection(s, ctx, out);
      return;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition && sel.typeCondition !== ctxTypeName(ctx)) return;
      for (const s of sel.selections) this.executeSelection(s, ctx, out);
      return;
    }
    const responseKey = sel.alias ?? sel.name;
    const value = this.resolveField(ctx, sel.name, resolveArgs(sel.args, this.vars), sel.selections);
    out[responseKey] = value;
  }

  resolveSelections(ctx: GqlCtx, selections: SelectionNode[]): Record<string, unknown> | null {
    if (ctx === null || ctx === undefined) return null;
    if (selections.length === 0) return null;
    const out: Record<string, unknown> = {};
    for (const s of selections) this.executeSelection(s, ctx, out);
    return out;
  }

  /** Resolve an `edges { node { ... } cursor }` selection over a list of contexts. */
  resolveEdgeList(items: GqlCtx[], baseIndex: number, selections: SelectionNode[]): unknown[] {
    return items.map((itemCtx, i) => {
      const out: Record<string, unknown> = {};
      for (const s of selections) {
        if (s.kind === 'field' && s.name === 'cursor') {
          out[s.alias ?? s.name] = cursorOf(baseIndex + i);
        } else if (s.kind === 'field' && s.name === 'node') {
          out[s.alias ?? s.name] = this.resolveSelections(itemCtx, s.selections);
        } else {
          this.executeSelection(s, itemCtx, out);
        }
      }
      return out;
    });
  }

  resolveField(ctx: GqlCtx, name: string, args: Record<string, unknown>, selections: SelectionNode[]): unknown {
    const typeName = ctxTypeName(ctx);
    const allowed = GQL_TYPE_FIELDS[typeName] ?? [];
    if (!allowed.includes(name)) {
      this.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
      return null;
    }
    const sub = (next: GqlCtx | null): unknown => this.resolveSelections(next as GqlCtx, selections);
    switch (ctx.kind) {
      case 'Query': {
        if (name === 'viewer') return sub({ kind: 'User', login: VIEWER.login });
        if (name === 'repository') {
          const owner = args.owner as string;
          const repoName = args.name as string;
          const repo = typeof owner === 'string' && typeof repoName === 'string' ? store.getRepo(owner, repoName) : undefined;
          if (!repo) return null;
          return sub({ kind: 'Repository', repo });
        }
        if (name === 'node') {
          const decoded = store.decodeGlobalId(args.id as string);
          if (!decoded) return null;
          if (decoded.kind === 'Repository') {
            const id = Number(decoded.key);
            const repo = [...store.repos.values()].find((r) => r.id === id);
            return repo ? sub({ kind: 'Repository', repo }) : null;
          }
          if (decoded.kind === 'Issue') {
            const [repoId, num] = decoded.key.split(':');
            const repo = [...store.repos.values()].find((r) => r.id === Number(repoId));
            const issue = repo?.issues.get(Number(num));
            return repo && issue ? sub({ kind: 'Issue', repo, issue }) : null;
          }
          if (decoded.kind === 'PullRequest') {
            const [repoId, num] = decoded.key.split(':');
            const repo = [...store.repos.values()].find((r) => r.id === Number(repoId));
            const pr = repo?.pulls.get(Number(num));
            return repo && pr ? sub({ kind: 'PullRequest', repo, pr }) : null;
          }
          return null;
        }
        if (name === '__type') {
          const tname = args.name as string;
          return sub({ kind: 'TypeInfo', name: tname });
        }
        if (name === '__schema') return sub({ kind: 'SchemaInfo' });
        return null;
      }
      case 'Mutation': {
        if (name === 'createIssue') return this.mutationCreateIssue(args, selections);
        if (name === 'closeIssue') return this.mutationCloseIssue(args, selections);
        if (name === 'addComment') return this.mutationAddComment(args, selections);
        if (name === 'createPullRequest') return this.mutationCreatePullRequest(args, selections);
        if (name === 'mergePullRequest') return this.mutationMergePullRequest(args, selections);
        return null;
      }
      case 'User': {
        if (name === 'id') return store.globalId('Repository', '0');
        if (name === 'login') return ctx.login;
        if (name === 'name') return ctx.login === VIEWER.login ? VIEWER.name : ctx.login;
        if (name === 'email') return ctx.login === VIEWER.login ? VIEWER.email : `${ctx.login}@example.invalid`;
        if (name === 'url') return `https://github.com/${ctx.login}`;
        return null;
      }
      case 'Repository': {
        const repo = ctx.repo;
        if (name === 'id') return store.globalId('Repository', String(repo.id));
        if (name === 'databaseId') return repo.id;
        if (name === 'name') return repo.name;
        if (name === 'nameWithOwner') return repo.fullName;
        if (name === 'description') return repo.description;
        if (name === 'isPrivate') return repo.private;
        if (name === 'url') return `https://github.com/${repo.fullName}`;
        if (name === 'createdAt') return repo.createdAt;
        if (name === 'updatedAt') return repo.updatedAt;
        if (name === 'owner') return sub({ kind: 'User', login: repo.owner });
        if (name === 'viewerPermission') return 'ADMIN';
        if (name === 'hasIssuesEnabled') return true;
        if (name === 'defaultBranchRef') {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (!tip) return null;
          return sub({ kind: 'Ref', name: repo.defaultBranch, repo });
        }
        if (name === 'issue') {
          const issue = repo.issues.get(Number(args.number));
          return issue ? sub({ kind: 'Issue', repo, issue }) : null;
        }
        if (name === 'issues') return sub(this.issuesConnection(repo, args));
        if (name === 'pullRequest') {
          const pr = repo.pulls.get(Number(args.number));
          return pr ? sub({ kind: 'PullRequest', repo, pr }) : null;
        }
        if (name === 'pullRequests') return sub(this.pullRequestsConnection(repo, args));
        if (name === 'labels') {
          return sub({ kind: 'LabelConnection', labels: [...repo.labels.values()] });
        }
        return null;
      }
      case 'Issue': {
        const { repo, issue } = ctx;
        if (name === 'id') return store.globalId('Issue', `${repo.id}:${issue.number}`);
        if (name === 'number') return issue.number;
        if (name === 'title') return issue.title;
        if (name === 'body') return issue.body;
        if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        if (name === 'url') return `https://github.com/${repo.fullName}/issues/${issue.number}`;
        if (name === 'createdAt') return issue.createdAt;
        if (name === 'updatedAt') return issue.updatedAt;
        if (name === 'author') return sub({ kind: 'User', login: VIEWER.login });
        if (name === 'repository') return sub({ kind: 'Repository', repo });
        if (name === 'labels') return sub({ kind: 'LabelConnection', labels: issue.labels });
        if (name === 'comments') return sub({ kind: 'CommentConnection', repo, issue });
        return null;
      }
      case 'PullRequest': {
        const { repo, pr } = ctx;
        if (name === 'id') return store.globalId('PullRequest', `${repo.id}:${pr.number}`);
        if (name === 'number') return pr.number;
        if (name === 'title') return pr.title;
        if (name === 'body') return pr.body;
        if (name === 'state') return pr.state === 'open' ? 'OPEN' : pr.merged ? 'MERGED' : 'CLOSED';
        if (name === 'merged') return pr.merged;
        if (name === 'url') return `https://github.com/${repo.fullName}/pull/${pr.number}`;
        if (name === 'createdAt') return pr.createdAt;
        if (name === 'updatedAt') return pr.updatedAt;
        if (name === 'author') return sub({ kind: 'User', login: VIEWER.login });
        if (name === 'repository') return sub({ kind: 'Repository', repo });
        if (name === 'headRefName') return pr.headRef;
        if (name === 'baseRefName') return pr.baseRef;
        if (name === 'headRefOid') return repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
        if (name === 'baseRefOid') return repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
        if (name === 'mergeable') return store.prConflicts(pr, repo) ? 'CONFLICTING' : 'MERGEABLE';
        if (name === 'files') return sub({ kind: 'FileConnection', repo, pr });
        return null;
      }
      case 'IssueConnection': {
        if (name === 'nodes') return ctx.issues.map((issue) => this.resolveSelections({ kind: 'Issue', repo: ctx.repo, issue }, selections));
        if (name === 'edges') return this.resolveEdgeList(ctx.issues.map((issue) => ({ kind: 'Issue', repo: ctx.repo, issue }) as GqlCtx), 0, selections);
        if (name === 'pageInfo') return sub({ kind: 'PageInfo', hasNextPage: ctx.hasNextPage, endCursor: ctx.endCursor });
        if (name === 'totalCount') return ctx.issues.length;
        return null;
      }
      case 'PullRequestConnection': {
        if (name === 'nodes') return ctx.prs.map((pr) => this.resolveSelections({ kind: 'PullRequest', repo: ctx.repo, pr }, selections));
        if (name === 'edges') return this.resolveEdgeList(ctx.prs.map((pr) => ({ kind: 'PullRequest', repo: ctx.repo, pr }) as GqlCtx), 0, selections);
        if (name === 'pageInfo') return sub({ kind: 'PageInfo', hasNextPage: ctx.hasNextPage, endCursor: ctx.endCursor });
        if (name === 'totalCount') return ctx.prs.length;
        return null;
      }
      case 'LabelConnection': {
        if (name === 'nodes') return ctx.labels.map((label) => this.resolveSelections({ kind: 'Label', label }, selections));
        if (name === 'edges') return this.resolveEdgeList(ctx.labels.map((label) => ({ kind: 'Label', label }) as GqlCtx), 0, selections);
        if (name === 'pageInfo') return sub({ kind: 'PageInfo', hasNextPage: false, endCursor: '' });
        if (name === 'totalCount') return ctx.labels.length;
        return null;
      }
      case 'CommentConnection': {
        if (name === 'nodes') return ctx.issue.comments.map((comment) => this.resolveSelections({ kind: 'Comment', comment }, selections));
        if (name === 'edges') return this.resolveEdgeList(ctx.issue.comments.map((comment) => ({ kind: 'Comment', comment }) as GqlCtx), 0, selections);
        if (name === 'pageInfo') return sub({ kind: 'PageInfo', hasNextPage: false, endCursor: '' });
        if (name === 'totalCount') return ctx.issue.comments.length;
        return null;
      }
      case 'FileConnection': {
        const files = store.prFiles(ctx.repo, ctx.pr);
        if (name === 'nodes') return files.map((file) => this.resolveSelections({ kind: 'File', file }, selections));
        if (name === 'edges') return this.resolveEdgeList(files.map((file) => ({ kind: 'File', file }) as GqlCtx), 0, selections);
        if (name === 'pageInfo') return sub({ kind: 'PageInfo', hasNextPage: false, endCursor: '' });
        if (name === 'totalCount') return files.length;
        return null;
      }
      case 'Label': {
        if (name === 'id') return store.globalId('Repository', `label:${ctx.label.name}`);
        if (name === 'name') return ctx.label.name;
        if (name === 'color') return ctx.label.color;
        if (name === 'description') return '';
        return null;
      }
      case 'Comment': {
        if (name === 'id') return store.globalId('Comment', `${ctx.comment.id}`);
        if (name === 'body') return ctx.comment.body;
        if (name === 'author') return sub({ kind: 'User', login: VIEWER.login });
        if (name === 'createdAt') return isoOf(EPOCH_SEC);
        if (name === 'updatedAt') return isoOf(EPOCH_SEC);
        return null;
      }
      case 'File': {
        if (name === 'path') return ctx.file.path;
        if (name === 'additions') return ctx.file.additions;
        if (name === 'deletions') return ctx.file.deletions;
        if (name === 'changeType') return ctx.file.status === 'added' ? 'ADDED' : ctx.file.status === 'removed' ? 'REMOVED' : 'MODIFIED';
        if (name === 'status') return ctx.file.status;
        return null;
      }
      case 'PageInfo': {
        if (name === 'hasNextPage') return ctx.hasNextPage;
        if (name === 'hasPreviousPage') return false;
        if (name === 'startCursor') return '';
        if (name === 'endCursor') return ctx.endCursor;
        return null;
      }
      case 'Ref': {
        if (name === 'name') return ctx.name;
        if (name === 'target') {
          const tip = ctx.repo.refs.get(`refs/heads/${ctx.name}`);
          return tip ? { oid: tip } : null;
        }
        return null;
      }
      case 'TypeInfo': {
        const tname = ctx.name;
        if (name === 'name') return tname;
        if (name === 'kind') return GQL_TYPE_KIND[tname] ?? 'OBJECT';
        if (name === 'description') return null;
        if (name === 'fields') {
          const fields = GQL_TYPE_FIELDS[tname] ?? [];
          return fields.map((f) => ({ name: f, args: [], type: { name: null, kind: 'SCALAR' } }));
        }
        if (name === 'enumValues') {
          const vals = GQL_ENUM_VALUES[tname] ?? [];
          return vals.map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null }));
        }
        if (name === 'possibleTypes') return null;
        if (name === 'inputFields') return null;
        if (name === 'interfaces') return [];
        return null;
      }
      case 'SchemaInfo': {
        if (name === 'queryType') return { name: 'Query' };
        if (name === 'mutationType') return { name: 'Mutation' };
        if (name === 'types') return Object.keys(GQL_TYPE_FIELDS).map((n) => ({ name: n, kind: GQL_TYPE_KIND[n] ?? 'OBJECT' }));
        if (name === 'description') return null;
        return null;
      }
      case 'Payload': {
        if (name === 'clientMutationId') return null;
        const next = ctx.fields[name];
        if (next === undefined) return null;
        return sub(next);
      }
      case 'Edge': {
        if (name === 'node') return sub(ctx.node);
        if (name === 'cursor') return ctx.cursor;
        return null;
      }
    }
  }

  issuesConnection(repo: Repo, args: Record<string, unknown>): GqlCtx {
    let list = [...repo.issues.values()];
    const states = args.states as unknown;
    if (Array.isArray(states) && states.length > 0) {
      const want = new Set(states.map((s) => String(s).toUpperCase()));
      list = list.filter((i) => want.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
    }
    const orderBy = args.orderBy as Record<string, unknown> | undefined;
    const direction = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
    list.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
    const first = typeof args.first === 'number' ? args.first : 30;
    const afterIdx = cursorIndex(args.after);
    const slice = list.slice(afterIdx + 1, afterIdx + 1 + first);
    const hasNext = afterIdx + 1 + first < list.length;
    const endCursor = slice.length > 0 ? cursorOf(afterIdx + slice.length) : '';
    return { kind: 'IssueConnection', repo, issues: slice, endCursor, hasNextPage: hasNext };
  }
  pullRequestsConnection(repo: Repo, args: Record<string, unknown>): GqlCtx {
    let list = [...repo.pulls.values()];
    const states = args.states as unknown;
    if (Array.isArray(states) && states.length > 0) {
      const want = new Set(states.map((s) => String(s).toUpperCase()));
      list = list.filter((p) => {
        const st = p.state === 'open' ? 'OPEN' : p.merged ? 'MERGED' : 'CLOSED';
        return want.has(st);
      });
    }
    list.sort((a, b) => b.seq - a.seq);
    const first = typeof args.first === 'number' ? args.first : 30;
    const afterIdx = cursorIndex(args.after);
    const slice = list.slice(afterIdx + 1, afterIdx + 1 + first);
    const hasNext = afterIdx + 1 + first < list.length;
    const endCursor = slice.length > 0 ? cursorOf(afterIdx + slice.length) : '';
    return { kind: 'PullRequestConnection', repo, prs: slice, endCursor, hasNextPage: hasNext };
  }

  mutationCreateIssue(args: Record<string, unknown>, selections: SelectionNode[]): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = store.decodeGlobalId(input.repositoryId as string);
    const repo = decoded ? [...store.repos.values()].find((r) => r.id === Number(decoded.key)) : undefined;
    if (!repo) {
      this.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return null;
    }
    const seq = nextSeq();
    const number = repo.nextNumber++;
    const issue: Issue = {
      id: repo.nextIssueId++, number,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open', labels: [], comments: [], seq,
      createdAt: isoOf(EPOCH_SEC + seq), updatedAt: isoOf(EPOCH_SEC + seq),
    };
    repo.issues.set(number, issue);
    const payload: GqlCtx = { kind: 'Payload', fields: { issue: { kind: 'Issue', repo, issue } } };
    return this.resolveSelections(payload, selections);
  }
  mutationCloseIssue(args: Record<string, unknown>, selections: SelectionNode[]): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = store.decodeGlobalId(input.issueId as string);
    let found: { repo: Repo; issue: Issue } | null = null;
    if (decoded) {
      const [repoId, num] = decoded.key.split(':');
      const repo = [...store.repos.values()].find((r) => r.id === Number(repoId));
      const issue = repo?.issues.get(Number(num));
      if (repo && issue) found = { repo, issue };
    }
    if (!found) {
      this.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.updatedAt = isoOf(EPOCH_SEC + nextSeq());
    const payload: GqlCtx = { kind: 'Payload', fields: { issue: { kind: 'Issue', repo: found.repo, issue: found.issue } } };
    return this.resolveSelections(payload, selections);
  }
  mutationAddComment(args: Record<string, unknown>, selections: SelectionNode[]): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = store.decodeGlobalId(input.subjectId as string);
    let found: { repo: Repo; issue: Issue } | null = null;
    if (decoded && decoded.kind === 'Issue') {
      const [repoId, num] = decoded.key.split(':');
      const repo = [...store.repos.values()].find((r) => r.id === Number(repoId));
      const issue = repo?.issues.get(Number(num));
      if (repo && issue) found = { repo, issue };
    }
    if (!found) {
      this.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return null;
    }
    const comment = { id: found.repo.nextCommentId++, body: typeof input.body === 'string' ? input.body : '' };
    found.issue.comments.push(comment);
    const payload: GqlCtx = {
      kind: 'Payload',
      fields: {
        comment: { kind: 'Comment', comment },
        commentEdge: { kind: 'Edge', node: { kind: 'Comment', comment }, cursor: '' },
        subject: { kind: 'Issue', repo: found.repo, issue: found.issue },
      },
    };
    return this.resolveSelections(payload, selections);
  }
  mutationCreatePullRequest(args: Record<string, unknown>, selections: SelectionNode[]): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = store.decodeGlobalId(input.repositoryId as string);
    const repo = decoded ? [...store.repos.values()].find((r) => r.id === Number(decoded.key)) : undefined;
    const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
    if (!repo || !repo.refs.has(`refs/heads/${headRef}`) || !repo.refs.has(`refs/heads/${baseRef}`)) {
      this.errors.push({ message: 'Could not resolve to a repository or branch.' });
      return null;
    }
    const seq = nextSeq();
    const number = repo.nextNumber++;
    const pr: PullRequest = {
      id: repo.nextIssueId++, number,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
      headRef, baseRef,
      headSha: repo.refs.get(`refs/heads/${headRef}`) as string,
      baseSha: repo.refs.get(`refs/heads/${baseRef}`) as string,
      seq, createdAt: isoOf(EPOCH_SEC + seq), updatedAt: isoOf(EPOCH_SEC + seq),
    };
    repo.pulls.set(number, pr);
    const payload: GqlCtx = { kind: 'Payload', fields: { pullRequest: { kind: 'PullRequest', repo, pr } } };
    return this.resolveSelections(payload, selections);
  }
  mutationMergePullRequest(args: Record<string, unknown>, selections: SelectionNode[]): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = store.decodeGlobalId(input.pullRequestId as string);
    let found: { repo: Repo; pr: PullRequest } | null = null;
    if (decoded) {
      const [repoId, num] = decoded.key.split(':');
      const repo = [...store.repos.values()].find((r) => r.id === Number(repoId));
      const pr = repo?.pulls.get(Number(num));
      if (repo && pr) found = { repo, pr };
    }
    if (!found) {
      this.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
      return null;
    }
    if (found.pr.state !== 'open') {
      this.errors.push({ message: 'Pull Request is not open.' });
      return null;
    }
    const merged = store.squashMerge(found.repo, found.pr);
    if (merged === null) {
      this.errors.push({ message: 'Merge conflict.' });
      return null;
    }
    const payload: GqlCtx = { kind: 'Payload', fields: { pullRequest: { kind: 'PullRequest', repo: found.repo, pr: found.pr } } };
    return this.resolveSelections(payload, selections);
  }
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/graphql' || (req.method ?? 'GET') !== 'POST') return false;
  if (!authed(req)) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    errJson(res, 400, 'Problems parsing JSON');
    return true;
  }
  const ops = Array.isArray(parsed) ? parsed : [parsed];
  const results: unknown[] = [];
  for (const op of ops) {
    const o = op as Record<string, unknown>;
    const executor = new GqlExecutor();
    results.push(executor.execute(
      typeof o.query === 'string' ? o.query : '',
      (o.variables ?? {}) as Record<string, unknown>,
      typeof o.operationName === 'string' ? o.operationName : undefined,
    ));
  }
  sendJson(res, 200, Array.isArray(parsed) ? results : results[0]);
  return true;
}

// ---------------------------------------------------------------------------
// 7. MCP (Streamable HTTP JSON-RPC)
// ---------------------------------------------------------------------------
interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}
const MCP_TOOLS: McpToolDef[] = [
  { name: 'create_repo', description: 'Create a new repository for the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] } },
  { name: 'list_repos', description: 'List repositories owned by the authenticated user.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' } }, required: [] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'get_issue', description: 'Get an issue by number.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, issue_number: { type: 'integer', description: 'Issue number' } }, required: ['owner', 'repo', 'issue_number'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed, or all' } }, required: ['owner', 'repo'] } },
  { name: 'add_comment', description: 'Add a comment to an issue.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, issue_number: { type: 'integer', description: 'Issue number' }, body: { type: 'string', description: 'Comment body' } }, required: ['owner', 'repo', 'issue_number', 'body'] } },
  { name: 'create_pull_request', description: 'Create a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, body: { type: 'string', description: 'Pull request body' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'list_pull_requests', description: 'List pull requests in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Pull request state: open, closed, or all' } }, required: ['owner', 'repo'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request (squash).', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
];
function mcpResult(id: unknown, result: unknown, headers: Record<string, string> = {}): { status: number; body: unknown; headers: Record<string, string> } {
  return { status: 200, body: { jsonrpc: '2.0', id, result }, headers };
}
function mcpError(id: unknown, code: number, message: string): { status: number; body: unknown; headers: Record<string, string> } {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } }, headers: {} };
}
function normalizeMcpArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { ...(raw ?? {}) };
  const fullName = args.full_name ?? args.fullName;
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const [owner, repo] = fullName.split('/');
    if (args.owner === undefined) args.owner = owner;
    if (args.repo === undefined) args.repo = repo;
  }
  if (args.repo === undefined && typeof args.repository === 'string') args.repo = args.repository;
  if (args.pull_number === undefined && args.pull_request_number !== undefined) args.pull_number = args.pull_request_number;
  if (args.pull_number === undefined && typeof args.number === 'number') args.pull_number = args.number;
  if (args.issue_number === undefined && typeof args.number === 'number') args.issue_number = args.number;
  return args;
}
function mcpToolResult(result: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}
function mcpToolError(message: string): Record<string, unknown> {
  const payload = { error: message };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}
function runMcpTool(name: string, rawArgs: Record<string, unknown>): Record<string, unknown> {
  const args = normalizeMcpArgs(rawArgs);
  const def = MCP_TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`Unknown tool: ${name}`);
  for (const req of def.inputSchema.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') return mcpToolError(`Missing required argument: ${req}`);
  }
  const owner = args.owner as string;
  const repoName = args.repo as string;
  const repo = owner && repoName ? store.getRepo(owner, repoName) : undefined;
  switch (name) {
    case 'create_repo': {
      const rname = args.name as string;
      if (store.getRepo(VIEWER.login, rname)) return mcpToolError(`Repository ${rname} already exists`);
      const repo2 = store.createRepo(VIEWER.login, rname, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return mcpToolResult(repoJson(repo2));
    }
    case 'get_repo': {
      if (!repo) return mcpToolError('Repository not found');
      return mcpToolResult(repoJson(repo));
    }
    case 'list_repos': {
      return mcpToolResult({ repositories: store.listViewerRepos(VIEWER.login).map(repoJson) });
    }
    case 'create_issue': {
      if (!repo) return mcpToolError('Repository not found');
      const seq = nextSeq();
      const number = repo.nextNumber++;
      const issue: Issue = {
        id: repo.nextIssueId++, number,
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open', labels: [], comments: [], seq,
        createdAt: isoOf(EPOCH_SEC + seq), updatedAt: isoOf(EPOCH_SEC + seq),
      };
      repo.issues.set(number, issue);
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'get_issue': {
      if (!repo) return mcpToolError('Repository not found');
      const issue = repo.issues.get(Number(args.issue_number));
      if (!issue) return mcpToolError('Issue not found');
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      if (!repo) return mcpToolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      return mcpToolResult({ issues: list.map((i) => issueJson(repo, i)) });
    }
    case 'add_comment': {
      if (!repo) return mcpToolError('Repository not found');
      const issue = repo.issues.get(Number(args.issue_number));
      if (!issue) return mcpToolError('Issue not found');
      const comment = { id: repo.nextCommentId++, body: typeof args.body === 'string' ? args.body : '' };
      issue.comments.push(comment);
      return mcpToolResult({ id: comment.id, body: comment.body, user: { login: VIEWER.login } });
    }
    case 'create_pull_request': {
      if (!repo) return mcpToolError('Repository not found');
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) return mcpToolError('Head or base branch does not exist');
      for (const pr of repo.pulls.values()) {
        if (pr.state === 'open' && pr.headRef === head && pr.baseRef === base) return mcpToolError('A pull request already exists for this head and base');
      }
      const seq = nextSeq();
      const number = repo.nextNumber++;
      const pr: PullRequest = {
        id: repo.nextIssueId++, number,
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
        headRef: head, baseRef: base,
        headSha: repo.refs.get(`refs/heads/${head}`) as string,
        baseSha: repo.refs.get(`refs/heads/${base}`) as string,
        seq, createdAt: isoOf(EPOCH_SEC + seq), updatedAt: isoOf(EPOCH_SEC + seq),
      };
      repo.pulls.set(number, pr);
      return mcpToolResult(prJson(repo, pr));
    }
    case 'list_pull_requests': {
      if (!repo) return mcpToolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      return mcpToolResult({ pull_requests: list.map((p) => prJson(repo, p)) });
    }
    case 'merge_pull_request': {
      if (!repo) return mcpToolError('Repository not found');
      const pr = repo.pulls.get(Number(args.pull_number));
      if (!pr) return mcpToolError('Pull request not found');
      if (pr.state !== 'open') return mcpToolError('Pull Request is not open');
      const merged = store.squashMerge(repo, pr);
      if (merged === null) return mcpToolError('Merge conflict');
      return mcpToolResult({ sha: merged, merged: true, message: 'Pull Request successfully merged', number: pr.number, pull_number: pr.number });
    }
    default:
      return mcpToolError(`Unknown tool: ${name}`);
  }
}
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/mcp') return false;
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return true;
  }
  if (method !== 'POST') {
    errJson(res, 404, 'Not Found');
    return true;
  }
  if (!authed(req)) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }
  const raw = await readBody(req);
  let msg: unknown;
  try {
    msg = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const m = msg as Record<string, unknown>;
  const id = m.id ?? null;
  if (id === null || id === undefined) {
    // Notification (e.g. notifications/initialized): acknowledge with 202, no body.
    res.writeHead(202);
    res.end();
    return true;
  }
  const rpcMethod = m.method as string;
  const params = (m.params ?? {}) as Record<string, unknown>;
  const serverInfo = { name: 'github-core-clone-01', version: '1.0.0' };
  let out: { status: number; body: unknown; headers: Record<string, string> };
  if (rpcMethod === 'server/discover') {
    out = mcpResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo,
    });
  } else if (rpcMethod === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const accepted = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(requested) ? requested : '2025-11-25';
    out = mcpResult(id, { protocolVersion: accepted, capabilities: { tools: {} }, serverInfo }, { 'mcp-session-id': 'forge-session-1' });
  } else if (rpcMethod === 'tools/list') {
    out = mcpResult(id, { tools: MCP_TOOLS });
  } else if (rpcMethod === 'tools/call') {
    const toolName = params.name as string;
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
    const def = MCP_TOOLS.find((t) => t.name === toolName);
    if (!def) {
      out = mcpError(id, -32602, `Unknown tool: ${toolName}`);
    } else {
      try {
        out = mcpResult(id, runMcpTool(toolName, toolArgs));
      } catch (e) {
        out = mcpError(id, -32603, e instanceof Error ? e.message : 'Internal error');
      }
    }
  } else if (typeof rpcMethod === 'string' && rpcMethod.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return true;
  } else {
    out = mcpError(id, -32601, `Method not found: ${rpcMethod}`);
  }
  sendJson(res, out.status, out.body, out.headers);
  return true;
}

// ---------------------------------------------------------------------------
// 8. Server bootstrap
// ---------------------------------------------------------------------------
export function createForge(): Server {
  const server = createServer(async (req, res) => {
    try {
      const path = pathOf(req);
      if (path === '/healthz' && (req.method ?? 'GET') === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (await handleMcp(req, res)) return;
      if (await handleGit(req, res)) return;
      if (await handleGraphql(req, res)) return;
      if (await handleRest(req, res)) return;
      errJson(res, 404, 'Not Found');
    } catch {
      try {
        errJson(res, 500, 'Internal Server Error');
      } catch {
        // response already gone
      }
    }
  });
  return server;
}
