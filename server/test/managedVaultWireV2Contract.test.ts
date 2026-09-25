import { describe, expect, it } from "vitest";

import { decodeManagedVaultBlobV2, encodeManagedVaultBlobV2,
  MANAGED_VAULT_CHUNK_BYTES, MANAGED_VAULT_FORMAT_V2,
  ManagedVaultWireV2Error } from "@adeno/contracts";
import { stageManagedVaultWireV2Stream, stageVaultWireStream,
  VaultWireStreamError, type VaultWireStagingSink } from
  "../src/managed/vaultWireStream.js";

// Structural fixture only. These bytes are not valid AES-GCM ciphertext.
const blob = { format: MANAGED_VAULT_FORMAT_V2,
  blobId: new Uint8Array(16).fill(0x11), plaintextSize: 3,
  chunkSize: MANAGED_VAULT_CHUNK_BYTES,
  chunks: [{ iv: new Uint8Array(12).fill(0x22),
    ciphertext: new Uint8Array(19).fill(0x33).buffer }] };

async function* fragments(bytes: Uint8Array) {
  const width = bytes.byteLength > 1_000_000 ? 64 * 1024 : 7;
  for (let offset = 0; offset < bytes.byteLength; offset += width)
    yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + width));
}

function staging() {
  const chunks: Buffer[] = [];
  let committed = false;
  let aborted = false;
  const sink: VaultWireStagingSink = {
    begin: () => undefined,
    append: (chunk) => { chunks.push(chunk.ciphertext); },
    commit: () => { committed = true; },
    abort: () => { aborted = true; chunks.length = 0; },
  };
  return { sink, chunks, get committed() { return committed; },
    get aborted() { return aborted; } };
}

describe("server-only managed v2 framing contract", () => {
  it("reads the shared v2 frame across transport fragments but never authenticates its payload", async () => {
    const wire = encodeManagedVaultBlobV2(blob);
    const parsed = decodeManagedVaultBlobV2(Buffer.from(wire));
    expect(encodeManagedVaultBlobV2(parsed)).toEqual(wire);
    const store = staging();
    const header = await stageManagedVaultWireV2Stream(fragments(wire), store.sink);
    expect(header).toEqual({ wireVersion: 2, blobId: "11".repeat(16), plaintextSize: 3,
      chunkCount: 1, expectedWireBytes: wire.byteLength });
    expect(store.committed).toBe(true);
    expect(store.chunks[0]).toEqual(Buffer.alloc(19, 0x33));
    await expect(stageVaultWireStream(fragments(wire), staging().sink))
      .rejects.toBeInstanceOf(VaultWireStreamError);
  });

  it("rejects legacy v1, unknown versions, truncated and trailing bytes", async () => {
    const wire = encodeManagedVaultBlobV2(blob);
    const legacy = wire.slice();
    legacy[4] = 1;
    const unknown = wire.slice();
    unknown[4] = 3;
    for (const changed of [legacy, unknown, wire.subarray(0, -1),
      Uint8Array.from([...wire, 0])]) {
      expect(() => decodeManagedVaultBlobV2(changed)).toThrow(ManagedVaultWireV2Error);
      const store = staging();
      await expect(stageManagedVaultWireV2Stream(fragments(changed), store.sink))
        .rejects.toBeInstanceOf(VaultWireStreamError);
      expect(store.committed).toBe(false);
      expect(store.chunks).toHaveLength(0);
    }
  });

  it("rejects repeated chunk IVs in the v2 stream before publication", async () => {
    const large = encodeManagedVaultBlobV2({ ...blob,
      plaintextSize: MANAGED_VAULT_CHUNK_BYTES + 1,
      chunks: [{ iv: new Uint8Array(12).fill(1),
        ciphertext: new Uint8Array(MANAGED_VAULT_CHUNK_BYTES + 16).buffer },
      { iv: new Uint8Array(12).fill(2), ciphertext: new Uint8Array(17).buffer }] });
    const secondIv = 33 + 12 + 4 + MANAGED_VAULT_CHUNK_BYTES + 16;
    large.set(large.subarray(33, 45), secondIv);
    const store = staging();
    await expect(stageManagedVaultWireV2Stream(fragments(large), store.sink))
      .rejects.toBeInstanceOf(VaultWireStreamError);
    expect(store.committed).toBe(false);
    expect(store.aborted).toBe(true);
    expect(store.chunks).toHaveLength(0);
  });
});
