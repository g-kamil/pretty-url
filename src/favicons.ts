import type { DataAdapter } from 'obsidian';

export type FaviconAdapter = Pick<DataAdapter, 'exists' | 'read' | 'write' | 'writeBinary' | 'getResourcePath' | 'mkdir' | 'rmdir' | 'remove'>;
export type FaviconRequest = (url: string) => Promise<{ status: number; arrayBuffer: ArrayBuffer }>;

type ImageFormat = 'ico' | 'png' | 'jpg' | 'gif' | 'webp';
interface Metadata {
  origin: string;
  format: ImageFormat | null;
  cachedAt?: string;
}
interface Entry {
  owner: FaviconCache;
  origin: string;
  id?: string;
  imagePath?: string;
  resource?: string | null;
  promise: Promise<string | null>;
  resolve: (resource: string | null) => void;
}
interface SharedState {
  tail: Promise<void>;
  activeRequests: number;
  queued: Set<Entry>;
}
type CacheRegistry = WeakMap<FaviconAdapter, Map<string, SharedState>>;

const MAX_BYTES = 256 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const FORMATS: Record<ImageFormat, true> = { ico: true, png: true, jpg: true, gif: true, webp: true };
// plugin:reload evaluates a new module while old native calls and writes can
// still finish. Use the main renderer window, never the active popout window.
const RUNTIME_KEY = Symbol.for('pretty-url.favicon-cache.runtime');
const runtime = window as unknown as Record<symbol, CacheRegistry | undefined>;
const REGISTRY = runtime[RUNTIME_KEY] ?? new WeakMap<FaviconAdapter, Map<string, SharedState>>();
if (!runtime[RUNTIME_KEY]) Object.defineProperty(window, RUNTIME_KEY, { value: REGISTRY });

function matches(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  for (let index = 0; index < signature.length; index++) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

function pngHeader(bytes: Uint8Array, view: DataView, offset = 0, size = bytes.length): boolean {
  if (size < 33 || !matches(bytes, offset, PNG_SIGNATURE)) return false;
  const depth = bytes[offset + 24];
  const color = bytes[offset + 25];
  const validDepth = (color === 0 && (depth === 1 || depth === 2 || depth === 4 || depth === 8 || depth === 16))
    || (color === 3 && (depth === 1 || depth === 2 || depth === 4 || depth === 8))
    || ((color === 2 || color === 4 || color === 6) && (depth === 8 || depth === 16));
  return validDepth && view.getUint32(offset + 8) === 13 && view.getUint32(offset + 12) === 0x49484452
    && view.getInt32(offset + 16) > 0 && view.getInt32(offset + 20) > 0
    && bytes[offset + 26] === 0 && bytes[offset + 27] === 0 && bytes[offset + 28] <= 1;
}

function dibHeader(view: DataView, offset: number, size: number): boolean {
  const headerSize = view.getUint32(offset, true);
  if ((headerSize !== 12 && headerSize !== 40 && headerSize !== 108 && headerSize !== 124) || size < headerSize) return false;
  const core = headerSize === 12;
  const width = core ? view.getUint16(offset + 4, true) : view.getInt32(offset + 4, true);
  const height = core ? view.getUint16(offset + 6, true) : view.getInt32(offset + 8, true);
  const planes = view.getUint16(offset + (core ? 8 : 12), true);
  const depth = view.getUint16(offset + (core ? 10 : 14), true);
  return width > 0 && height !== 0 && planes === 1
    && (depth === 1 || depth === 4 || depth === 8 || depth === 16 || depth === 24 || depth === 32);
}

/** Header checks only; the renderer reports any subsequent image decoding failure. */
function imageFormat(data: ArrayBuffer): ImageFormat | null {
  if (!data.byteLength || data.byteLength > MAX_BYTES) return null;
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  if (pngHeader(bytes, view)) return 'png';
  if (bytes.length >= 6 && view.getUint16(0, true) === 0 && view.getUint16(2, true) === 1) {
    const count = view.getUint16(4, true);
    const directoryEnd = 6 + count * 16;
    if (!count || directoryEnd > bytes.length) return null;
    for (let index = 6; index < directoryEnd; index += 16) {
      const size = view.getUint32(index + 8, true);
      const offset = view.getUint32(index + 12, true);
      if (bytes[index + 3] !== 0 || size < 12 || offset < directoryEnd || offset + size > bytes.length) return null;
      if (!pngHeader(bytes, view, offset, size) && !dibHeader(view, offset, size)) return null;
    }
    return 'ico';
  }
  if (bytes.length >= 6 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    && bytes[3] !== 0 && bytes[3] !== 0xff && bytes[3] !== 0xd8 && bytes[3] !== 0xd9
    && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return 'jpg';
  if (bytes.length >= 14 && view.getUint32(0) === 0x47494638 && (bytes[4] === 0x37 || bytes[4] === 0x39)
    && bytes[5] === 0x61 && view.getUint16(6, true) > 0 && view.getUint16(8, true) > 0
    && (!(bytes[10] & 0x80) || bytes.length >= 14 + 3 * (1 << ((bytes[10] & 7) + 1)))
    && bytes[bytes.length - 1] === 0x3b) return 'gif';
  if (bytes.length >= 20 && view.getUint32(0) === 0x52494646 && view.getUint32(4, true) + 8 === bytes.length
    && view.getUint32(8) === 0x57454250) {
    const chunk = view.getUint32(12);
    const size = view.getUint32(16, true);
    if (size + (size % 2) + 20 > bytes.length) return null;
    if (chunk === 0x56503820 && size >= 10 && !(bytes[20] & 1)
      && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a
      && (view.getUint16(26, true) & 0x3fff) > 0 && (view.getUint16(28, true) & 0x3fff) > 0) return 'webp';
    if (chunk === 0x5650384c && size >= 5 && bytes[20] === 0x2f && !(bytes[24] & 0xe0)) return 'webp';
    if (chunk === 0x56503858 && size >= 10 && !(bytes[20] & 0xc1)
      && bytes[21] === 0 && bytes[22] === 0 && bytes[23] === 0) return 'webp';
  }
  return null;
}

/** Direct-origin favicons only. Every get returns a persisted local resource or a miss. */
export class FaviconCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ids = new Map<string, Promise<string>>();
  private enabled = true;
  private disposed = false;
  private folderReady = false;
  private ignoreDisk = false;
  private readonly shared: SharedState;

  constructor(private readonly adapter: FaviconAdapter, private readonly folder: string, private readonly request: FaviconRequest) {
    let folders = REGISTRY.get(adapter);
    if (!folders) {
      folders = new Map();
      REGISTRY.set(adapter, folders);
    }
    let shared = folders.get(folder);
    if (!shared) {
      shared = { tail: Promise.resolve(), activeRequests: 0, queued: new Set() };
      folders.set(folder, shared);
    }
    this.shared = shared;
  }

  get(origin: string): Promise<string | null> {
    if (!this.enabled || this.disposed) return Promise.resolve(null);
    const existing = this.entries.get(origin);
    if (existing) return existing.promise;
    let resolve!: Entry['resolve'];
    const promise = new Promise<string | null>(done => { resolve = done; });
    const entry: Entry = { owner: this, origin, promise, resolve };
    this.entries.set(origin, entry);
    void this.load(entry);
    return promise;
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.cancelPending();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending();
    this.entries.clear();
  }

  clear(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.cancelPending();
    this.entries.clear();
    // A failed disk clear must not reload old records into this session.
    this.ignoreDisk = true;
    return this.disk(async () => {
      try {
        if (await this.adapter.exists(this.folder)) await this.adapter.rmdir(this.folder, true);
        this.ignoreDisk = false;
      } finally {
        this.folderReady = false;
      }
    });
  }

  markUnavailable(origin: string, resource: string): Promise<void> {
    const entry = this.entries.get(origin);
    if (this.disposed || !entry || entry.resource !== resource) return Promise.resolve();
    entry.resource = null;
    entry.promise = Promise.resolve(null);
    return this.disk(async () => {
      const current = () => !this.disposed && this.entries.get(origin) === entry;
      if (!current()) return;
      const metadataPath = this.metadataPath(entry);
      let attempted = false;
      try {
        await this.ensureFolder();
        if (!current()) return;
        attempted = true;
        await this.adapter.write(metadataPath, JSON.stringify({ origin, format: null } satisfies Metadata));
      } catch {
        // The in-memory miss is authoritative even when the adapter cannot write.
      }
      if (!current()) {
        if (attempted) await this.remove(metadataPath);
        if (entry.imagePath) await this.remove(entry.imagePath);
        return;
      }
      if (entry.imagePath) await this.remove(entry.imagePath);
    });
  }

  private current(entry: Entry): boolean {
    return this.enabled && !this.disposed && this.entries.get(entry.origin) === entry;
  }

  private cancelPending(): void {
    for (const [origin, entry] of this.entries) {
      if (entry.resource === undefined) {
        this.shared.queued.delete(entry);
        this.entries.delete(origin);
        entry.resolve(null);
      }
    }
  }

  private finish(entry: Entry, resource: string | null): void {
    if (!this.current(entry)) return;
    entry.resource = resource;
    entry.resolve(resource);
  }

  private id(origin: string): Promise<string> {
    let id = this.ids.get(origin);
    if (!id) {
      id = window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(origin)).then(digest => {
        let hex = '';
        for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
        return hex;
      });
      this.ids.set(origin, id);
    }
    return id;
  }

  private metadataPath(entry: Entry): string {
    return `${this.folder}/${entry.id}.json`;
  }

  private resource(path: string, cachedAt: string): string {
    const local = this.adapter.getResourcePath(path);
    return `${local}${local.includes('?') ? '&' : '?'}pretty-url-favicon=${encodeURIComponent(cachedAt)}`;
  }

  private async load(entry: Entry): Promise<void> {
    try {
      entry.id = await this.id(entry.origin);
      const cached = await this.disk(async (): Promise<string | null | undefined> => {
        if (!this.current(entry)) return null;
        if (this.ignoreDisk || !await this.adapter.exists(this.metadataPath(entry))) return undefined;
        let metadata: Metadata;
        try { metadata = JSON.parse(await this.adapter.read(this.metadataPath(entry))) as Metadata; }
        catch { return null; }
        if (!metadata || metadata.origin !== entry.origin) return null;
        if (metadata.format === null) return null;
        if (FORMATS[metadata.format] !== true || typeof metadata.cachedAt !== 'string' || !metadata.cachedAt || metadata.cachedAt.length > 128) return null;
        entry.imagePath = `${this.folder}/${entry.id}.${metadata.format}`;
        if (!await this.adapter.exists(entry.imagePath)) return null;
        return this.resource(entry.imagePath, metadata.cachedAt);
      });
      if (!this.current(entry)) return;
      if (cached !== undefined) this.finish(entry, cached);
      else {
        this.shared.queued.add(entry);
        this.pump();
      }
    } catch {
      this.finish(entry, null);
    }
  }

  private pump(): void {
    for (const entry of this.shared.queued) {
      if (this.shared.activeRequests >= 3) break;
      this.shared.queued.delete(entry);
      if (!entry.owner.current(entry)) continue;
      this.shared.activeRequests++;
      void entry.owner.fetch(entry);
    }
  }

  private async fetch(entry: Entry): Promise<void> {
    let format: ImageFormat | null = null;
    let data: ArrayBuffer | undefined;
    try {
      const response = await this.request(`${entry.origin}/favicon.ico`);
      if (this.current(entry) && response.status >= 200 && response.status < 300) {
        format = imageFormat(response.arrayBuffer);
        if (format) data = response.arrayBuffer;
      }
    } catch {
      // Native errors and non-images are permanent misses until an explicit clear.
    } finally {
      this.shared.activeRequests--;
      this.pump();
    }
    if (!this.current(entry)) return;
    const resource = await this.persist(entry, format, data);
    this.finish(entry, resource);
  }

  private persist(entry: Entry, format: ImageFormat | null, data?: ArrayBuffer): Promise<string | null> {
    return this.disk(async () => {
      if (!this.current(entry)) return null;
      const metadata: Metadata = { origin: entry.origin, format: null };
      const metadataPath = this.metadataPath(entry);
      let imageAttempted = false;
      let metadataAttempted = false;
      let resource: string | null = null;
      try {
        await this.ensureFolder();
        if (!this.current(entry)) return null;
        if (format && data) {
          entry.imagePath = `${this.folder}/${entry.id}.${format}`;
          imageAttempted = true;
          try {
            await this.adapter.writeBinary(entry.imagePath, data);
            if (this.current(entry)) {
              metadata.cachedAt = window.crypto.randomUUID();
              resource = this.resource(entry.imagePath, metadata.cachedAt);
              metadata.format = format;
            }
          } catch {
            await this.remove(entry.imagePath);
          }
        }
        if (this.current(entry)) {
          metadataAttempted = true;
          await this.adapter.write(metadataPath, JSON.stringify(metadata));
        }
      } catch {
        // A resource is returned only after its real binary file was written.
      }
      if (!this.current(entry)) {
        if (imageAttempted && entry.imagePath) await this.remove(entry.imagePath);
        if (metadataAttempted) await this.remove(metadataPath);
        return null;
      }
      return resource;
    });
  }

  private disk<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.shared.tail.then(operation);
    this.shared.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureFolder(): Promise<void> {
    if (this.folderReady) return;
    if (!await this.adapter.exists(this.folder)) await this.adapter.mkdir(this.folder);
    this.folderReady = true;
  }

  private async remove(path: string): Promise<void> {
    try { await this.adapter.remove(path); }
    catch { /* Best-effort cleanup cannot invalidate an in-memory miss. */ }
  }
}
