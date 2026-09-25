import { describe, expect, it } from "vitest";

import { encryptVaultBlob, generateVaultKeyMaterial, importVaultKey,
  VAULT_CHUNK_BYTES } from "../../web/src/crypto/vault.js";
import { encodeVaultBlob } from "../../web/src/crypto/vaultWire.js";
import { stageVaultWireStream, VaultWireStreamError,
  type VaultWireStagingSink } from "../src/managed/vaultWireStream.js";

async function fixture(size = VAULT_CHUNK_BYTES + 17) {
  const material = generateVaultKeyMaterial();
  const key = await importVaultKey(material);
  material.fill(0);
  const plaintext = new Uint8Array(size);
  plaintext.fill(42);
  const encrypted = await encryptVaultBlob(key, plaintext,
    { householdId: "fictional-family-a", objectId: "opaque-object-a", revision: 1 });
  return { encrypted, wire: Buffer.from(encodeVaultBlob(encrypted)) };
}

async function* fragments(bytes: Uint8Array, widths = [1, 3, 7, 4093, 65_537]) {
  let offset = 0;
  let index = 0;
  while (offset < bytes.byteLength) {
    const end = Math.min(bytes.byteLength, offset + widths[index % widths.length]!);
    yield bytes.subarray(offset, end);
    offset = end;
    index += 1;
  }
}

function staging() {
  const pending: { index: number; iv: Buffer; ciphertext: Buffer }[] = [];
  let published = false;
  let aborted = false;
  const sink: VaultWireStagingSink = {
    begin: () => { expect(pending).toHaveLength(0); },
    append: (chunk) => { pending.push(chunk); },
    commit: () => { published = true; },
    abort: () => { aborted = true; pending.length = 0; },
  };
  return { sink, pending, get published() { return published; },
    get aborted() { return aborted; } };
}

describe("bounded encrypted vault wire stream", () => {
  it("stages actual browser ciphertext across arbitrary transport boundaries", async () => {
    const { encrypted, wire } = await fixture();
    const store = staging();
    const header = await stageVaultWireStream(fragments(wire), store.sink);
    expect(header).toEqual({ wireVersion: 1,
      blobId: Buffer.from(encrypted.blobId).toString("hex"),
      plaintextSize: VAULT_CHUNK_BYTES + 17, chunkCount: 2,
      expectedWireBytes: wire.byteLength });
    expect(store.published).toBe(true);
    expect(store.aborted).toBe(false);
    expect(store.pending).toHaveLength(2);
    for (const [index, chunk] of store.pending.entries()) {
      expect(chunk.index).toBe(index);
      expect(chunk.iv).toEqual(Buffer.from(encrypted.chunks[index]!.iv));
      expect(chunk.ciphertext).toEqual(Buffer.from(encrypted.chunks[index]!.ciphertext));
    }
  });

  it("rejects truncated, trailing, contradictory, and oversized wire before commit", async () => {
    const { wire } = await fixture(41);
    const changed = (offset: number, value: number) => {
      const copy = Buffer.from(wire);
      copy[offset] = value;
      return copy;
    };
    const oversizedHeader = Buffer.from(wire.subarray(0, 33));
    oversizedHeader.writeUInt32BE(100 * VAULT_CHUNK_BYTES + 1, 21);
    for (const bytes of [
      wire.subarray(0, -1), Buffer.concat([wire, Buffer.from([0])]),
      changed(0, 0), changed(4, 2), changed(26, 0), changed(32, 2),
      changed(48, 0), oversizedHeader,
    ]) {
      const store = staging();
      await expect(stageVaultWireStream(fragments(bytes), store.sink))
        .rejects.toBeInstanceOf(VaultWireStreamError);
      expect(store.published).toBe(false);
      expect(store.pending).toHaveLength(0);
    }
  });

  it("accepts bounded transport fragments and aborts failed staging", async () => {
    const { wire: largeWire } = await fixture();
    const largeStore = staging();
    await stageVaultWireStream(fragments(largeWire, [VAULT_CHUNK_BYTES]), largeStore.sink);
    expect(largeStore.published).toBe(true);
    const oversizedStore = staging();
    await expect(stageVaultWireStream(fragments(largeWire, [largeWire.byteLength]),
      oversizedStore.sink)).rejects.toBeInstanceOf(VaultWireStreamError);
    expect(oversizedStore.published).toBe(false);
    const { wire } = await fixture(17);
    let aborted = false;
    const failingSink: VaultWireStagingSink = {
      begin: () => undefined,
      append: () => { throw new Error("synthetic staging failure"); },
      commit: () => { throw new Error("must not commit"); },
      abort: () => { aborted = true; },
    };
    await expect(stageVaultWireStream(fragments(wire), failingSink))
      .rejects.toThrow("synthetic staging failure");
    expect(aborted).toBe(true);
  });

  it("allows bounded empty yields between fields and after the final byte", async () => {
    const { wire } = await fixture(17);
    async function* withEmpties() {
      yield new Uint8Array(0);
      for await (const part of fragments(wire, [1])) {
        yield part;
        yield new Uint8Array(0);
      }
      yield new Uint8Array(0);
    }
    const store = staging();
    await stageVaultWireStream(withEmpties(), store.sink);
    expect(store.published).toBe(true);
  });

  it("bounds empty-fragment loops and cancels the source on failure", async () => {
    let closed = false;
    async function* endlessEmpties() {
      try {
        while (true) yield new Uint8Array(0);
      } finally { closed = true; }
    }
    const store = staging();
    await expect(stageVaultWireStream(endlessEmpties(), store.sink))
      .rejects.toBeInstanceOf(VaultWireStreamError);
    expect(store.published).toBe(false);
    expect(closed).toBe(true);
  });

  it("bounds total empty fragments even when nonempty bytes separate them", async () => {
    const { wire } = await fixture(2000);
    async function* alternating() {
      for (const byte of wire) {
        yield Uint8Array.of(byte);
        yield new Uint8Array(0);
      }
    }
    const store = staging();
    await expect(stageVaultWireStream(alternating(), store.sink))
      .rejects.toBeInstanceOf(VaultWireStreamError);
    expect(store.published).toBe(false);
    expect(store.aborted).toBe(true);
  });

  it("stops before commit when aborted during staged writes", async () => {
    const { wire } = await fixture(17);
    const controller = new AbortController();
    const store = staging();
    const sink: VaultWireStagingSink = { ...store.sink,
      append: async (chunk) => {
        await store.sink.append(chunk);
        controller.abort();
      },
    };
    await expect(stageVaultWireStream(fragments(wire, [1]), sink,
      controller.signal)).rejects.toBeInstanceOf(VaultWireStreamError);
    expect(store.published).toBe(false);
    expect(store.aborted).toBe(true);
    expect(store.pending).toHaveLength(0);
  });

  it("does not mistake a structurally valid envelope for proof of encryption", async () => {
    const bytes = Buffer.alloc(33 + 12 + 4 + 16, 0);
    bytes.write("ADEN", 0, "ascii");
    bytes[4] = 1;
    bytes.writeUInt32BE(VAULT_CHUNK_BYTES, 25);
    bytes.writeUInt32BE(1, 29);
    bytes.writeUInt32BE(16, 45);
    bytes.fill(0x41, 49); // Plain ASCII in the alleged ciphertext field.
    const store = staging();
    const header = await stageVaultWireStream(fragments(bytes, [1]), store.sink);
    expect(header.plaintextSize).toBe(0);
    expect(store.published).toBe(true);
    expect(store.pending[0]!.ciphertext.toString("ascii")).toBe("AAAAAAAAAAAAAAAA");
  });
});
