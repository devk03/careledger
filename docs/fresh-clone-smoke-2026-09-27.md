# Fresh-clone community self-host smoke test — 2026-09-27

Tested public feature-branch commit: `74d99a5de4f6d6aa33ef8bc2bd76739c8a825c2e`
(`devk/crash-safe-intake`). This is not a release commit or managed E2EE
deployment.

An independent directory under `/private/tmp` received a depth-one clone
from the public GitHub repository. The clone's `.env.example` was copied to
`.env` without adding any inference key or changing source files. On Docker
28.0.4, an isolated Compose project `adeno-fresh-gpyznq` built the locked
image and started the community edition on loopback port 18081. The image
build completed, including the reviewed-asset check, frontend TypeScript/Vite
build and Python application import. Its non-release source-check command ran
with no release SHA, so it did **not** verify the cloned commit or establish
release-image provenance. The
container became healthy; `/`, `/health/live`, and `/health/ready` each
returned HTTP 200.

The service was stopped and started again twice with `--no-build` and the
same volume. Before and after the second stop/start, `/data/app.sqlite` had
the same inode (`147771`), size (802,816 bytes), mtime (`1790539393`) and
SHA-256 (`f010456c7ab0e52f158a442fc3a6ed2e363adb2c980b9ffebe5c4f2803bdb9fd`).
The container became healthy and `/health/ready` returned 200 after startup;
an immediate request during the restart returned an empty reply, so readiness
must be polled rather than assumed at process start. The smoke-test service
was then stopped; its separate container, volume, image and temp clone were
left intact for inspection. No existing local service, Railway deployment,
family record, production database, or API key was touched. The clone's
privacy audit reported zero findings across its 495 tracked paths and 495
shallow-history blobs.

This supports build, startup and same-file persistence across that restart
for the current
community edition on this host. It does **not** prove that a nontechnical
independent tester completed owner setup within 20 minutes, that real records
are safe, that the managed TypeScript E2EE service starts, or that Railway
health, backups and rollback work. The default community server can read its
local records; it is not the hosted family-controlled encryption target.
