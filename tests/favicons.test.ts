import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after, type TestContext } from 'node:test';
import { transform } from 'esbuild';
import type { FaviconAdapter, FaviconRequest } from '../src/favicons';
import type * as FaviconModule from '../src/favicons';

// Install the renderer before loading the real module: its reload-persistent
// registry is created at evaluation time, not when the first test starts.
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const rendererWindow = { crypto: webcrypto };
Object.defineProperty(globalThis, 'window', { configurable: true, value: rendererWindow });
const { FaviconCache } = require('../src/favicons') as typeof FaviconModule;
type FaviconCache = InstanceType<typeof FaviconCache>;
after(() => {
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
  else Reflect.deleteProperty(globalThis, 'window');
});

const FOLDER = 'plugin/favicon-cache';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
// A complete grayscale JPEG: one quantization table, one-symbol Huffman tables,
// a 1x1 frame, and a single DC-zero/EOB entropy-coded block.
const JPEG = Buffer.from([
  0xff, 0xd8,
  0xff, 0xdb, 0, 67, 0, ...new Array<number>(64).fill(1),
  0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
  0xff, 0xc4, 0, 20, 0, 1, ...new Array<number>(15).fill(0), 0,
  0xff, 0xc4, 0, 20, 0x10, 1, ...new Array<number>(15).fill(0), 0,
  0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x3f, 0xff, 0xd9,
]);
const ICO = Buffer.alloc(22 + PNG.length);
ICO.writeUInt16LE(1, 2);
ICO.writeUInt16LE(1, 4);
ICO[6] = ICO[7] = 1;
ICO.writeUInt16LE(1, 10);
ICO.writeUInt16LE(32, 12);
ICO.writeUInt32LE(PNG.length, 14);
ICO.writeUInt32LE(22, 18);
PNG.copy(ICO, 22);
const DIB_ICO = Buffer.alloc(70);
ICO.copy(DIB_ICO, 0, 0, 22);
DIB_ICO.writeUInt32LE(48, 14);
DIB_ICO.writeUInt32LE(40, 22);
DIB_ICO.writeInt32LE(1, 26);
DIB_ICO.writeInt32LE(2, 30);
DIB_ICO.writeUInt16LE(1, 34);
DIB_ICO.writeUInt16LE(32, 36);
DIB_ICO.writeUInt32LE(8, 42);
DIB_ICO[64] = DIB_ICO[65] = 255;

function response(bytes: Uint8Array = PNG, status = 200): { status: number; arrayBuffer: ArrayBuffer } {
  return { status, arrayBuffer: Uint8Array.from(bytes).buffer as ArrayBuffer };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let compiledModule: Promise<string> | undefined;
async function reloadCacheClass(): Promise<typeof FaviconCache> {
  // Re-evaluate the actual module, as plugin:reload does. A second class from
  // the original imported module would miss module-local lifecycle bugs.
  compiledModule ??= readFile(join(__dirname, '../src/favicons.ts'), 'utf8')
    .then(source => transform(source, { loader: 'ts', format: 'cjs', target: 'es2021' }))
    .then(result => result.code);
  const module = { exports: {} as { FaviconCache: typeof FaviconCache } };
  new Function('module', 'exports', 'window', await compiledModule)(module, module.exports, rendererWindow);
  return module.exports.FaviconCache;
}

async function tempAdapter(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pretty-url-favicons-'));
  await mkdir(join(root, 'plugin'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter: FaviconAdapter = {
    async exists(path) {
      try { await access(join(root, path)); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    read: path => readFile(join(root, path), 'utf8'),
    write: (path, data) => writeFile(join(root, path), data),
    writeBinary: (path, data) => writeFile(join(root, path), new Uint8Array(data)),
    getResourcePath: path => pathToFileURL(join(root, path)).href,
    mkdir: async path => { await mkdir(join(root, path)); },
    rmdir: (path, recursive) => rm(join(root, path), { recursive }),
    remove: path => rm(join(root, path)),
  };
  return { adapter, root };
}

function cacheFor(t: TestContext, adapter: FaviconAdapter, request: FaviconRequest): FaviconCache {
  const cache = new FaviconCache(adapter, FOLDER, request);
  t.after(() => cache.dispose());
  return cache;
}

async function localServer(t: TestContext, bytes: Uint8Array, status = 200) {
  const paths: string[] = [];
  const server = createServer((request, result) => {
    paths.push(request.url ?? '');
    result.writeHead(status, { 'Content-Type': 'application/octet-stream' });
    result.end(bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { origin: `http://127.0.0.1:${address.port}`, paths };
}

const nativeRequest: FaviconRequest = async url => {
  const result = await fetch(url);
  return { status: result.status, arrayBuffer: await result.arrayBuffer() };
};

function controlledRequest() {
  const starts: Array<{ url: string; finish: (bytes?: Uint8Array) => void }> = [];
  const listeners = new Set<() => void>();
  let active = 0;
  let maximum = 0;
  const request: FaviconRequest = url => {
    const done = deferred<ReturnType<typeof response>>();
    active++;
    maximum = Math.max(maximum, active);
    let finished = false;
    starts.push({ url, finish(bytes = PNG) {
      assert.equal(finished, false, 'A native request must only be completed once');
      finished = true;
      done.resolve(response(bytes));
    } });
    for (const listener of listeners) listener();
    return done.promise.finally(() => { active--; });
  };
  return {
    request, starts,
    get maximum() { return maximum; },
    async waitForStarts(count: number) {
      if (starts.length >= count) return;
      await new Promise<void>(resolve => {
        const listener = () => {
          if (starts.length < count) return;
          listeners.delete(listener);
          resolve();
        };
        listeners.add(listener);
      });
    },
  };
}

/** An I/O completion barrier, not a timing-based sleep or network polling loop. */
function observeMissingRecords(adapter: FaviconAdapter) {
  const exists = adapter.exists.bind(adapter);
  const listeners = new Set<() => void>();
  let count = 0;
  adapter.exists = async (path, sensitive) => {
    const found = await exists(path, sensitive);
    if (!found && path.endsWith('.json')) {
      count++;
      for (const listener of listeners) listener();
    }
    return found;
  };
  return async (expected: number) => {
    if (count < expected) await new Promise<void>(resolve => {
      const listener = () => {
        if (count < expected) return;
        listeners.delete(listener);
        resolve();
      };
      listeners.add(listener);
    });
    // Let the microtask continuation of the observed exists() queue its request.
    await setImmediate();
  };
}

async function localBytes(resource: string | null): Promise<Buffer> {
  assert.ok(resource);
  assert.equal(new URL(resource).protocol, 'file:');
  return readFile(fileURLToPath(resource));
}

test('coalesces repeated card origins into one direct request and a memoized local file', { timeout: 10_000 }, async t => {
  const { adapter, root } = await tempAdapter(t);
  const fixture = await localServer(t, PNG);
  const cache = cacheFor(t, adapter, nativeRequest);
  const pending = Array.from({ length: 48 }, () => cache.get(fixture.origin));
  for (const promise of pending) assert.equal(promise, pending[0]);
  const resources = await Promise.all(pending);
  assert.ok(resources[0]);
  assert.ok(resources.every(resource => resource === resources[0]));
  assert.deepEqual(fixture.paths, ['/favicon.ico']);
  assert.deepEqual(await localBytes(resources[0]), PNG);
  assert.equal(await cache.get(fixture.origin), resources[0]);
  const id = createHash('sha256').update(fixture.origin).digest('hex');
  assert.deepEqual((await readdir(join(root, FOLDER))).sort(), [`${id}.json`, `${id}.png`].sort());
});

test('persists positive and negative outcomes across instances with no network requests', { timeout: 10_000 }, async t => {
  const { adapter } = await tempAdapter(t);
  const positive = await localServer(t, ICO);
  const negative = await localServer(t, Buffer.from('<html>not an icon</html>'), 404);
  const first = cacheFor(t, adapter, nativeRequest);
  const resource = await first.get(positive.origin);
  assert.deepEqual(await localBytes(resource), ICO);
  assert.equal(await first.get(negative.origin), null);
  first.dispose();
  let calls = 0;
  const second = cacheFor(t, adapter, async () => { calls++; throw new Error('No network expected for persisted records'); });
  assert.equal(await second.get(positive.origin), resource);
  assert.equal(await second.get(negative.origin), null);
  assert.equal(calls, 0);
  assert.deepEqual(positive.paths, ['/favicon.ico']);
  assert.deepEqual(negative.paths, ['/favicon.ico']);
});

test('accepts ICO, PNG, JPEG, GIF, and WebP based on their bytes', { timeout: 10_000 }, async t => {
  const { adapter } = await tempAdapter(t);
  const fixtures = new Map([['ico', ICO], ['png', PNG], ['jpg', JPEG], ['gif', GIF], ['webp', WEBP]]);
  const cache = cacheFor(t, adapter, async url => response(fixtures.get(new URL(url).hostname.split('.')[0])!));
  for (const [format, bytes] of fixtures) {
    const resource = await cache.get(`https://${format}.example`);
    assert.ok(resource);
    assert.ok(new URL(resource).pathname.endsWith(`.${format}`));
    assert.deepEqual(await localBytes(resource), bytes);
  }
  const dib = cacheFor(t, adapter, async () => response(DIB_ICO));
  assert.deepEqual(await localBytes(await dib.get('https://dib.example')), DIB_ICO);
});

test('malformed, oversized, empty, HTML, SVG, status, and native errors are permanent cached misses', { timeout: 10_000 }, async t => {
  const { adapter } = await tempAdapter(t);
  const badPng = Buffer.from(PNG);
  badPng.writeUInt32BE(0, 16);
  const badIco = Buffer.from(ICO);
  badIco.writeUInt32LE(ICO.length + 1, 18);
  const badDib = Buffer.from(DIB_ICO);
  badDib.writeInt32LE(0, 26);
  const badWebp = Buffer.from(WEBP);
  badWebp.writeUInt32LE(0, 4);
  const oversized = Buffer.alloc(256 * 1024 + 1);
  PNG.copy(oversized);
  const failures = [
    response(Buffer.alloc(0)), response(Buffer.from('<html><link rel="icon"></html>')),
    response(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    response(Buffer.from([1, 2, 3])), response(PNG.subarray(0, 16)), response(badPng),
    response(badIco), response(badDib), response(badWebp), response(oversized), response(PNG, 503), null,
  ];
  const calls = new Map<string, number>();
  const cache = cacheFor(t, adapter, async url => {
    const origin = new URL(url).origin;
    calls.set(origin, (calls.get(origin) ?? 0) + 1);
    const result = failures[Number(new URL(url).hostname.split('.')[0])];
    if (!result) throw new Error('Native transport rejected');
    return result;
  });
  const origins = failures.map((_, index) => `https://${index}.example`);
  assert.deepEqual(await Promise.all(origins.map(origin => cache.get(origin))), origins.map(() => null));
  assert.deepEqual(await Promise.all(origins.map(origin => cache.get(origin))), origins.map(() => null));
  for (const origin of origins) assert.equal(calls.get(origin), 1);
  const warm = cacheFor(t, adapter, async () => { assert.fail('Persisted misses must not retry'); });
  assert.deepEqual(await Promise.all(origins.map(origin => warm.get(origin))), origins.map(() => null));
});

test('bounds cold native requests to three without dropping queued origins', { timeout: 10_000 }, async t => {
  const { adapter } = await tempAdapter(t);
  const readMisses = observeMissingRecords(adapter);
  const native = controlledRequest();
  const cache = cacheFor(t, adapter, native.request);
  const pending = Array.from({ length: 7 }, (_, index) => cache.get(`https://cold-${index}.example`));
  await readMisses(7);
  assert.equal(native.starts.length, 3);
  native.starts.slice(0, 3).forEach(start => start.finish());
  await native.waitForStarts(6);
  native.starts.slice(3, 6).forEach(start => start.finish());
  await native.waitForStarts(7);
  native.starts[6].finish();
  const results = await Promise.all(pending);
  assert.equal(native.maximum, 3);
  for (const result of results) assert.deepEqual(await localBytes(result), PNG);
});

test('clear cancels queued work, retains native concurrency accounting, and cannot poison a fresh result', { timeout: 10_000 }, async t => {
  const { adapter } = await tempAdapter(t);
  const readMisses = observeMissingRecords(adapter);
  const native = controlledRequest();
  const cache = cacheFor(t, adapter, native.request);
  const pending = Array.from({ length: 6 }, (_, index) => cache.get(`https://clear-${index}.example`));
  await readMisses(6);
  assert.equal(native.starts.length, 3);
  const origin = new URL(native.starts[0].url).origin;
  await cache.clear();
  assert.deepEqual(await Promise.all(pending), pending.map(() => null));
  const fresh = cache.get(origin);
  await readMisses(7);
  assert.equal(native.starts.length, 3, 'Old native requests still occupy all slots after clear');
  native.starts[0].finish(GIF);
  await native.waitForStarts(4);
  assert.equal(native.starts[3].url, `${origin}/favicon.ico`);
  native.starts[3].finish(PNG);
  const resource = await fresh;
  native.starts[1].finish(GIF);
  native.starts[2].finish(GIF);
  await setImmediate();
  assert.equal(native.maximum, 3);
  assert.equal(native.starts.length, 4, 'Canceled queued origins never issue native requests');
  const warm = cacheFor(t, adapter, async () => { assert.fail('The fresh result should remain persisted'); });
  assert.equal(await warm.get(origin), resource);
  assert.deepEqual(await localBytes(resource), PNG);
});

test('clear waits out an already-started binary mutation before new writes', { timeout: 10_000 }, async t => {
  const { adapter, root } = await tempAdapter(t);
  const written = deferred<void>();
  const release = deferred<void>();
  const writeBinary = adapter.writeBinary.bind(adapter);
  let writes = 0;
  adapter.writeBinary = async (path, data, options) => {
    await writeBinary(path, data, options);
    if (++writes === 1) {
      written.resolve();
      await release.promise;
    }
  };
  let calls = 0;
  const cache = cacheFor(t, adapter, async () => { calls++; return response(); });
  const origin = 'https://writing.example';
  const stale = cache.get(origin);
  await written.promise;
  const clearing = cache.clear();
  const fresh = cache.get(origin);
  assert.equal(await stale, null);
  release.resolve();
  await clearing;
  const resource = await fresh;
  assert.deepEqual(await localBytes(resource), PNG);
  assert.equal(calls, 2);
  assert.equal((await readdir(join(root, FOLDER))).length, 2);
  const warm = cacheFor(t, adapter, async () => { assert.fail('Fresh write must survive stale mutation cleanup'); });
  assert.equal(await warm.get(origin), resource);
});

for (const cancellation of ['disable', 'dispose'] as const) {
  test(`${cancellation} during a binary write cannot delete a fresh image`, { timeout: 10_000 }, async t => {
    const { adapter } = await tempAdapter(t);
    const written = deferred<void>();
    const release = deferred<void>();
    const writeBinary = adapter.writeBinary.bind(adapter);
    let writes = 0;
    adapter.writeBinary = async (path, data, options) => {
      await writeBinary(path, data, options);
      if (++writes === 1) {
        written.resolve();
        await release.promise;
      }
    };
    const origin = `https://${cancellation}-writing.example`;
    let calls = 0;
    const request: FaviconRequest = async () => { calls++; return response(); };
    const old = cacheFor(t, adapter, request);
    const stale = old.get(origin);
    await written.promise;
    let replacement: FaviconCache;
    if (cancellation === 'dispose') {
      old.dispose();
      replacement = cacheFor(t, adapter, request);
    } else {
      old.setEnabled(false);
      old.setEnabled(true);
      replacement = old;
    }
    assert.equal(await stale, null);
    const fresh = replacement.get(origin);
    release.resolve();
    const resource = await fresh;
    assert.deepEqual(await localBytes(resource), PNG);
    assert.equal(calls, 2);
    const warm = cacheFor(t, adapter, async () => { assert.fail('Stale cleanup must not remove the fresh image'); });
    assert.equal(await warm.get(origin), resource);
  });
}

test('decoder failures persist and stale resource errors cannot reject a newer image after clear', { timeout: 10_000 }, async t => {
  const { adapter } = await tempAdapter(t);
  let calls = 0;
  const cache = cacheFor(t, adapter, async () => { calls++; return response(); });
  const origin = 'https://decoder.example';
  const original = await cache.get(origin);
  assert.ok(original);
  await cache.markUnavailable(origin, `${original}-wrong`);
  assert.equal(await cache.get(origin), original);
  await cache.markUnavailable(origin, original);
  assert.equal(await cache.get(origin), null);
  const miss = cacheFor(t, adapter, async () => { assert.fail('Decoder failures must persist'); });
  assert.equal(await miss.get(origin), null);
  await cache.clear();
  const fresh = await cache.get(origin);
  assert.ok(fresh);
  assert.notEqual(fresh, original, 'Explicit clear must bust the browser resource cache');
  await cache.markUnavailable(origin, original);
  assert.equal(await cache.get(origin), fresh);
  assert.deepEqual(await localBytes(fresh), PNG);
  assert.equal(calls, 2);
});

test('disable cancels queued and stale active work while retaining completed cache entries', { timeout: 10_000 }, async t => {
  const { adapter } = await tempAdapter(t);
  const readMisses = observeMissingRecords(adapter);
  const native = controlledRequest();
  const warmOrigin = 'https://retained.example';
  const cache = cacheFor(t, adapter, url => url.startsWith(`${warmOrigin}/`) ? Promise.resolve(response()) : native.request(url));
  const retained = await cache.get(warmOrigin);
  assert.ok(retained);
  const pending = Array.from({ length: 6 }, (_, index) => cache.get(`https://disabled-${index}.example`));
  await readMisses(7);
  assert.equal(native.starts.length, 3);
  const origin = new URL(native.starts[0].url).origin;
  cache.setEnabled(false);
  assert.deepEqual(await Promise.all(pending), pending.map(() => null));
  assert.equal(await cache.get(warmOrigin), null);
  native.starts[0].finish(GIF);
  await setImmediate();
  assert.equal(native.starts.length, 3);
  cache.setEnabled(true);
  assert.equal(await cache.get(warmOrigin), retained);
  const fresh = cache.get(origin);
  await native.waitForStarts(4);
  native.starts[3].finish(PNG);
  const resource = await fresh;
  native.starts[1].finish(GIF);
  native.starts[2].finish(GIF);
  await setImmediate();
  assert.equal(native.starts.length, 4);
  assert.equal(native.maximum, 3);
  const warm = cacheFor(t, adapter, async () => { assert.fail('A stale disabled request must not replace the fresh result'); });
  assert.equal(await warm.get(origin), resource);
  assert.deepEqual(await localBytes(resource), PNG);
});

test('dispose cannot issue queued calls or overwrite a new instance with stale native completions', { timeout: 10_000 }, async t => {
  const { adapter } = await tempAdapter(t);
  const readMisses = observeMissingRecords(adapter);
  const native = controlledRequest();
  const cache = cacheFor(t, adapter, native.request);
  const pending = Array.from({ length: 6 }, (_, index) => cache.get(`https://disposed-${index}.example`));
  await readMisses(6);
  assert.equal(native.starts.length, 3);
  const origin = new URL(native.starts[0].url).origin;
  cache.dispose();
  assert.deepEqual(await Promise.all(pending), pending.map(() => null));
  assert.equal(await cache.get(origin), null);
  const replacement = cacheFor(t, adapter, native.request);
  const fresh = replacement.get(origin);
  await readMisses(7);
  assert.equal(native.starts.length, 3, 'The disposed instance still owns three native slots');
  native.starts[0].finish(GIF);
  await native.waitForStarts(4);
  native.starts[3].finish(PNG);
  const resource = await fresh;
  native.starts[1].finish(GIF);
  native.starts[2].finish(GIF);
  await setImmediate();
  assert.equal(native.starts.length, 4);
  assert.equal(native.maximum, 3);
  const warm = cacheFor(t, adapter, async () => { assert.fail('Disposed work must not poison the replacement cache'); });
  assert.equal(await warm.get(origin), resource);
  assert.deepEqual(await localBytes(resource), PNG);
});

test('failed binary persistence remains an in-memory miss instead of a fake remote success or retry storm', { timeout: 10_000 }, async t => {
  const { adapter } = await tempAdapter(t);
  adapter.writeBinary = async () => { throw new Error('Read-only binary storage'); };
  let calls = 0;
  const cache = cacheFor(t, adapter, async () => { calls++; return response(); });
  const origin = 'https://binary-failure.example';
  assert.equal(await cache.get(origin), null);
  assert.deepEqual(await Promise.all(Array.from({ length: 30 }, () => cache.get(origin))), new Array(30).fill(null));
  assert.equal(calls, 1);
});

test('failed metadata persistence can only return an actually written local image', { timeout: 10_000 }, async t => {
  const { adapter } = await tempAdapter(t);
  adapter.write = async () => { throw new Error('Read-only metadata storage'); };
  let calls = 0;
  const cache = cacheFor(t, adapter, async () => { calls++; return response(); });
  const origin = 'https://metadata-failure.example';
  const resource = await cache.get(origin);
  assert.deepEqual(await localBytes(resource), PNG);
  assert.equal(await cache.get(origin), resource);
  assert.equal(calls, 1);
});

test('a failed disk clear is reported without reloading old records into the current session', { timeout: 10_000 }, async t => {
  const { adapter } = await tempAdapter(t);
  let calls = 0;
  const cache = cacheFor(t, adapter, async () => { calls++; return response(calls === 1 ? GIF : PNG); });
  const origin = 'https://clear-failure.example';
  const original = await cache.get(origin);
  assert.deepEqual(await localBytes(original), GIF);
  adapter.rmdir = async () => { throw new Error('Cannot remove cache directory'); };
  await assert.rejects(cache.clear(), /Cannot remove cache directory/);
  const resource = await cache.get(origin);
  assert.notEqual(resource, original);
  assert.deepEqual(await localBytes(resource), PNG);
  assert.equal(calls, 2);
});

test('explicit clear refetches both successes and failures and changes the local resource version', { timeout: 10_000 }, async t => {
  const { adapter } = await tempAdapter(t);
  const positive = 'https://clear-positive.example';
  const negative = 'https://clear-negative.example';
  let cleared = false;
  let calls = 0;
  const cache = cacheFor(t, adapter, async url => {
    calls++;
    return response(PNG, !cleared && url.startsWith(`${negative}/`) ? 404 : 200);
  });
  const original = await cache.get(positive);
  assert.ok(original);
  assert.equal(await cache.get(negative), null);
  assert.equal(calls, 2);
  await cache.clear();
  cleared = true;
  const fresh = await cache.get(positive);
  assert.ok(fresh);
  assert.notEqual(fresh, original);
  assert.deepEqual(await localBytes(fresh), PNG);
  assert.deepEqual(await localBytes(await cache.get(negative)), PNG);
  assert.equal(calls, 4);
});

test('module re-evaluation retains the shared three-request bound and drops disposed queued work', { timeout: 10_000 }, async t => {
  const ReloadedCache = await reloadCacheClass();
  assert.notEqual(ReloadedCache, FaviconCache);
  const { adapter } = await tempAdapter(t);
  const readMisses = observeMissingRecords(adapter);
  const native = controlledRequest();
  const old = cacheFor(t, adapter, native.request);
  const stale = Array.from({ length: 6 }, (_, index) => old.get(`https://reload-old-${index}.example`));
  await readMisses(6);
  assert.equal(native.starts.length, 3);
  const sharedOrigin = new URL(native.starts[0].url).origin;
  old.dispose();
  assert.deepEqual(await Promise.all(stale), stale.map(() => null));
  const replacement = new ReloadedCache(adapter, FOLDER, native.request);
  t.after(() => replacement.dispose());
  const origins = [sharedOrigin, 'https://reload-new-1.example', 'https://reload-new-2.example', 'https://reload-new-3.example'];
  const fresh = origins.map(origin => replacement.get(origin));
  await readMisses(10);
  assert.equal(native.starts.length, 3, 'Reload must not start another three native requests');
  for (let index = 0; index < 3; index++) {
    native.starts[index].finish(GIF);
    await native.waitForStarts(index + 4);
  }
  native.starts.slice(3, 6).forEach(start => start.finish(PNG));
  await native.waitForStarts(7);
  native.starts[6].finish(PNG);
  const resources = await Promise.all(fresh);
  for (const resource of resources) assert.deepEqual(await localBytes(resource), PNG);
  assert.equal(native.maximum, 3);
  assert.equal(native.starts.length, 7);
  const warm = cacheFor(t, adapter, async () => { assert.fail('Stale module completions must not overwrite the new files'); });
  for (let index = 0; index < origins.length; index++) assert.equal(await warm.get(origins[index]), resources[index]);
});

test('module re-evaluation serializes old filesystem cleanup before a replacement writes', { timeout: 10_000 }, async t => {
  const ReloadedCache = await reloadCacheClass();
  const { adapter } = await tempAdapter(t);
  const written = deferred<void>();
  const release = deferred<void>();
  const writeBinary = adapter.writeBinary.bind(adapter);
  let writes = 0;
  adapter.writeBinary = async (path, data, options) => {
    await writeBinary(path, data, options);
    if (++writes === 1) {
      written.resolve();
      await release.promise;
    }
  };
  const origin = 'https://reload-writing.example';
  const old = cacheFor(t, adapter, async () => response());
  const stale = old.get(origin);
  await written.promise;
  old.dispose();
  assert.equal(await stale, null);
  const replacement = new ReloadedCache(adapter, FOLDER, async () => response());
  t.after(() => replacement.dispose());
  const fresh = replacement.get(origin);
  release.resolve();
  const resource = await fresh;
  assert.deepEqual(await localBytes(resource), PNG);
  assert.equal(writes, 2);
  const warm = cacheFor(t, adapter, async () => { assert.fail('Reloaded write must survive cleanup from the old module'); });
  assert.equal(await warm.get(origin), resource);
});
