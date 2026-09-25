# PDF intake gate

Status: **closed** as of 2026-09-25. This is an engineering decision record, not permission to upload medical PDFs. The isolated parser preview returns `UNSUPPORTED` for every PDF. The TypeScript app has no PDF upload route connected to that worker, and no PDF bytes from a real case may be used in tests.

## What a `safe` verdict would have to mean

A `safe` PDF verdict must come from full-file structural inspection inside a short-lived child of the resource-limited, network-disabled parser container. It must bind to the exact received bytes and prove the protocol's page/object/geometry limits, `encrypted: false`, and `activeContent: false`. A header check, PDF keyword search, successful open in a viewer, or a clean malware scan is not that proof. Any parser warning, repair, unsupported feature, ambiguous structure, timeout, crash, oversized output, or limit breach rejects the file. Original bytes remain immutable; any rendered preview is a separate derived artifact and must never silently replace the source.

The initial policy should conservatively reject encryption; actions and scripts; embedded files and attachments; forms and XFA; rich media, 3D, launch, remote, or submission behavior; and unknown action-like constructs. It should examine the complete object graph, including compressed, incrementally updated, and unreferenced objects, plus every effective page box. Serving an original PDF inline is a separate browser security decision; a successful structural check alone does not authorize it. No PDF is promoted to `safe` until adversarial synthetic fixtures demonstrate this policy, including documents that look benign in raw bytes but hide actions in object streams.

## Parser choice and unresolved input boundary

[qpdf](https://qpdf.readthedocs.io/en/12.0/cli.html) is a candidate for structural validation and object JSON, not an active-content safety oracle. Its `--check` exit status does not establish that all stream contents conform, and warnings or recovery must fail this gate. [qpdf JSON](https://qpdf.readthedocs.io/en/11.8/json.html) includes unreferenced objects; it can support conservative traversal, but its semantics and resource use need version-pinned tests. The qpdf CLI requires a **seekable input file**, not PDF bytes on stdin. A private, bounded input mechanism that does not leave readable patient bytes behind must be designed and tested before adopting it. No temporary-file or native-helper design is approved by this record. The all-TypeScript pilot requirement must be reconciled explicitly with any native parser dependency.

Do not pass document text, filenames, qpdf diagnostics, or object JSON through the 2 KiB parser-socket reply or application logs. Return only the fixed protocol verdict and bounded numeric metadata. The parser child must have fixed arguments, a hard deadline, capped output, and no network, database, object-store, or Docker-daemon access.

## Synthetic exit tests before opening the gate

- Accept only after checking minimal, multipage, rotated, and inherited-page-box PDFs with known page/object counts and dimensions.
- Reject encrypted/password PDFs, malformed or repaired cross references, zero or excessive pages, oversized geometry, excessive objects, trailing/polyglot content, compressed or nested objects with actions, embedded files, forms/XFA, and unknown actions.
- Exercise large/compressed streams, memory/PID/output exhaustion, child hangs/crashes, digest mismatch, excess bytes, and restart after a failed parse. No partial success or truncated metadata is allowed.
- Verify the exact target-host isolation, a scanner that fails closed, authorized upload grants, immutable source storage, and recovery before Express can invoke PDF inspection.

The hosted family-controlled E2EE design adds a separate prerequisite: a server that cannot decrypt records cannot inspect their PDF plaintext. That mode needs an explicit client-side or family-authorized processing flow; this local trusted-server pilot does not prove one.
