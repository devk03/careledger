import { MANAGED_VAULT_CHUNK_BYTES, MANAGED_VAULT_WIRE_VERSION,
  MAX_MANAGED_VAULT_BYTES } from "@adeno/contracts";

const MAGIC = Buffer.from("ADEN", "ascii");
const HEADER_BYTES = 33;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CHUNK_HEADER_BYTES = IV_BYTES + 4;
const CHUNK_BYTES = MANAGED_VAULT_CHUNK_BYTES;
const MAX_PLAINTEXT_BYTES = MAX_MANAGED_VAULT_BYTES;
const MAX_CHUNKS = MAX_PLAINTEXT_BYTES / CHUNK_BYTES;
const MAX_WIRE_BYTES = HEADER_BYTES + MAX_PLAINTEXT_BYTES +
  MAX_CHUNKS * (CHUNK_HEADER_BYTES + TAG_BYTES);
const MAX_SOURCE_FRAGMENT_BYTES = CHUNK_BYTES;
const MAX_TOTAL_SOURCE_FRAGMENTS = 1_000_000;
const MAX_TOTAL_EMPTY_FRAGMENTS = 1024;

export type VaultWireHeader = {
  wireVersion: 1 | 2;
  blobId: string;
  plaintextSize: number;
  chunkCount: number;
  expectedWireBytes: number;
};

export type VaultWireChunk = {
  index: number;
  iv: Buffer;
  ciphertext: Buffer;
};

/**
 * The sink must stage chunks privately. commit must publish atomically only after
 * every byte is validated; abort must discard all staged data. Neither operation
 * may interpret the ciphertext as medical content.
 */
export interface VaultWireStagingSink {
  begin(header: VaultWireHeader): Promise<void> | void;
  append(chunk: VaultWireChunk): Promise<void> | void;
  commit(header: VaultWireHeader): Promise<void> | void;
  abort(): Promise<void> | void;
}

export class VaultWireStreamError extends Error {
  constructor() {
    super("Invalid encrypted vault wire format");
    this.name = "VaultWireStreamError";
  }
}

/**
 * Parses the browser's encrypted wire format with at most one copied ciphertext
 * chunk plus one copied, bounded source fragment in parser memory. Callers must
 * split larger source buffers before passing them here. This validates structure only:
 * it cannot prove that a client actually encrypted its bytes or verify AES-GCM.
 * The caller must enforce an HTTP deadline, destroy an aborted request stream,
 * and authenticate the staging sink. A producer must not mutate a yielded buffer
 * until the parser has consumed it.
 */
export async function stageVaultWireStream(
  source: AsyncIterable<Uint8Array>,
  sink: VaultWireStagingSink,
  signal?: AbortSignal,
): Promise<VaultWireHeader> {
  return stageVersionedVaultWireStream(source, sink, 1, signal);
}

/** V2 framing for opaque day/source/draft ciphertext; still not authorization. */
export async function stageManagedVaultWireV2Stream(
  source: AsyncIterable<Uint8Array>,
  sink: VaultWireStagingSink,
  signal?: AbortSignal,
): Promise<VaultWireHeader> {
  return stageVersionedVaultWireStream(source, sink, MANAGED_VAULT_WIRE_VERSION, signal);
}

async function stageVersionedVaultWireStream(
  source: AsyncIterable<Uint8Array>,
  sink: VaultWireStagingSink,
  requiredVersion: 1 | 2,
  signal?: AbortSignal,
): Promise<VaultWireHeader> {
  const reader = new BoundedReader(source, signal);
  let began = false;
  let committed = false;
  try {
    const bytes = await reader.readExactly(HEADER_BYTES);
    if (!bytes.subarray(0, MAGIC.length).equals(MAGIC) || bytes[4] !== requiredVersion)
      throw new VaultWireStreamError();
    const plaintextSize = bytes.readUInt32BE(21);
    const chunkSize = bytes.readUInt32BE(25);
    const chunkCount = bytes.readUInt32BE(29);
    if (plaintextSize > MAX_PLAINTEXT_BYTES || chunkSize !== CHUNK_BYTES ||
      chunkCount !== Math.max(1, Math.ceil(plaintextSize / CHUNK_BYTES)))
      throw new VaultWireStreamError();
    const expectedWireBytes = HEADER_BYTES + plaintextSize +
      chunkCount * (CHUNK_HEADER_BYTES + TAG_BYTES);
    reader.setExactLimit(expectedWireBytes);
    const header = { wireVersion: requiredVersion,
      blobId: bytes.subarray(5, 21).toString("hex"),
      plaintextSize, chunkCount, expectedWireBytes };
    began = true;
    await sink.begin(header);
    reader.checkAbort();
    const seenIvs = requiredVersion === MANAGED_VAULT_WIRE_VERSION ? new Set<string>() : null;
    for (let index = 0; index < chunkCount; index += 1) {
      const iv = await reader.readExactly(IV_BYTES);
      const ivId = iv.toString("hex");
      if (seenIvs?.has(ivId)) throw new VaultWireStreamError();
      seenIvs?.add(ivId);
      const length = (await reader.readExactly(4)).readUInt32BE(0);
      const expected = Math.max(0, Math.min(CHUNK_BYTES,
        plaintextSize - index * CHUNK_BYTES)) + TAG_BYTES;
      if (length !== expected) throw new VaultWireStreamError();
      const ciphertext = await reader.readExactly(length);
      await sink.append({ index, iv, ciphertext });
      reader.checkAbort();
    }
    await reader.expectEof();
    reader.checkAbort();
    await sink.commit(header);
    committed = true;
    return header;
  } catch (error) {
    if (began && !committed) {
      try { await sink.abort(); } catch { throw new VaultWireStreamError(); }
    }
    throw error;
  } finally {
    if (!committed) await reader.cancel();
  }
}

class BoundedReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current = new Uint8Array(0);
  private offset = 0;
  private received = 0;
  private limit = MAX_WIRE_BYTES;
  private fragmentCount = 0;
  private emptyFragmentCount = 0;

  constructor(source: AsyncIterable<Uint8Array>, private readonly signal?: AbortSignal) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  checkAbort(): void {
    if (this.signal?.aborted) throw new VaultWireStreamError();
  }

  setExactLimit(limit: number): void {
    if (limit > MAX_WIRE_BYTES || this.received > limit) throw new VaultWireStreamError();
    this.limit = limit;
  }

  async readExactly(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || length > CHUNK_BYTES + TAG_BYTES)
      throw new VaultWireStreamError();
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      this.checkAbort();
      if (this.offset === this.current.length) await this.nextFragment();
      const count = Math.min(length - written, this.current.length - this.offset);
      result.set(this.current.subarray(this.offset, this.offset + count), written);
      this.offset += count;
      written += count;
    }
    return result;
  }

  async expectEof(): Promise<void> {
    this.checkAbort();
    if (this.offset !== this.current.length || this.received !== this.limit)
      throw new VaultWireStreamError();
    while (true) {
      const next = await this.pull();
      if (next.done) return;
      if (next.value.byteLength !== 0) throw new VaultWireStreamError();
    }
  }

  async cancel(): Promise<void> {
    try { await this.iterator.return?.(); } catch { /* Preserve the parse failure. */ }
  }

  private async nextFragment(): Promise<void> {
    while (true) {
      const next = await this.pull();
      if (next.done || next.value.byteLength > MAX_SOURCE_FRAGMENT_BYTES)
        throw new VaultWireStreamError();
      if (next.value.byteLength === 0) continue;
      this.received += next.value.byteLength;
      if (this.received > this.limit) throw new VaultWireStreamError();
      this.current = Buffer.from(next.value);
      this.offset = 0;
      return;
    }
  }

  private async pull(): Promise<IteratorResult<Uint8Array>> {
    this.checkAbort();
    const next = await this.iterator.next();
    this.checkAbort();
    if (next.done) return next;
    if (!(next.value instanceof Uint8Array) ||
      ++this.fragmentCount > MAX_TOTAL_SOURCE_FRAGMENTS) throw new VaultWireStreamError();
    if (next.value.byteLength === 0 &&
      ++this.emptyFragmentCount > MAX_TOTAL_EMPTY_FRAGMENTS)
      throw new VaultWireStreamError();
    return next;
  }
}
