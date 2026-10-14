# Private scanner candidate

This is preparation for the trusted Hermes pilot, not proof that uploads are
ready. No application database or health record is mounted into either image.
The scanner accepts bounded bytes through a private local socket. The application
adapter returns only clean, detected or unavailable; errors never mean clean.

`Dockerfile.scanner` pins the Ubuntu base digest and Ubuntu ClamAV packages.
It installs a dedicated UID/GID 10004:10005 and root-owned configuration. The
application client needs group 10005 and explicitly trusts worker UID 10004.
The socket directory is 0710 and the socket 0660. No TCP endpoint is configured.
Only official signatures are loaded. Files over scanner expansion limits produce
a detection verdict. Existing/stale socket paths are not removed by a startup
wrapper: an operator must archive a stale socket before attempting recovery.

Signature provisioning is a separate once-only `freshclam` command with a
900-second lifetime and 15-second forced-exit bound. It may access the signature
service and writes only its dedicated signature volume. Preserve that volume;
do not download a full new signature set for every preview. The updater must
finish successfully before launching the network-disabled scanner. Never use
`freshclam --daemon` for this preview. There is no scheduled updater or monitor.

The daemon loads the signature volume read-only. It has one scanning thread,
bounded stream/expansion sizes and no automatic concurrent database reload.
It rejects signatures over two days old at startup. The application adapter also
queries the loaded daemon signature timestamp before each document scan, with a
bounded control request and no cached approval. The daemon runs with `TZ=UTC`;
the adapter validates its exact calendar date and weekday. Missing, malformed,
oversized, truncated, stale or more than five minutes future replies deny the
scan before document transfer. Age defaults to 48 hours and can only be shortened.
The same timestamp is checked again before returning a verdict, so a scan crossing
the freshness deadline cannot return clean. Production still needs a verified
manual update/restart procedure and acceptance of the complete intake path.
ClamAV's documented memory requirements are substantial; verify peak RSS and
host headroom before enabling production uploads. Do not weaken detection or
substitute a fabricated signature database to make a resource check pass.

The synthetic preview Compose file limits the worker to 480 seconds plus a
15-second forced-exit bound, disables restarts and caps memory at 1700 MiB.
Those limits are test settings, not a production sizing claim. Use a unique
Compose project, image tag and socket volume. The signature volume is explicitly
external and must already exist with the intended ownership. A probe client
mounts only the socket read-only, uses UID/GID 10001:10005, has no network and
runs under a 90-second bound. `runSyntheticScannerProbe.ts` generates a tiny PNG
and the inert EICAR antivirus test string; it accepts no document path/input and
prints only two verdict booleans. This verifies real detection and clean
transport when run against real official signatures, not general upload safety.

Before stopping or signaling a preview, inspect the exact container ID, image
digest, synthetic label and mounts. Preserve stopped containers and volumes.
Do not target existing application containers. A test passes only when the
updater exits zero, the scanner stays within its resource limit, the probe
reports both required verdicts and the scanner is confirmed stopped afterward.

Production still requires authenticated intake integration, stale-signature and
scanner-unavailable denial, database permissions, original persistence, parser
stress, manual publication, citation access and restore verification. All
database migration gates apply independently of this scanner preview.

On October 14, the candidate scanner Dockerfile/configuration built successfully
on Hermes as `adeno-scanner:candidate-20261014`, image
`sha256:2cc9478391f7ac4fc08240c72608dbd6603ef88fcdab03313d041be5c1a3ab4e`.
The build installed engine packages into the container image only and prevented
service startup during package installation. Server typecheck/build and seven
scanner adapter tests passed. Signature provisioning and real detection are
separate checks; this build alone does not prove scanner availability.
The initial updater failed closed because private archive extraction produced
root-only configuration files. The Dockerfile now fixes the nonsecret config
permissions explicitly at build time, independently of checkout/archive umask.
The configuration directory also has explicit traversal permissions, and a build
step runs as UID 10004 to require readable configurations before image publication.

The corrected image, `adeno-scanner:candidate3-20261014`, is
`sha256:f542bdc2c7ea3e6a73bda611d312f6c96f11d1dcfd947a0b03e6cf4bb36cf86a`.
Its once-only updater downloaded and load-tested official daily 28153, main 63
and bytecode 339, exiting 0 without OOM. A fresh non-root network-disabled
scanner used only that signature volume read-only and a private socket volume.
Observed idle memory was about 959 MiB within the 1700 MiB cap; this is not a
peak-load sizing result. A separate network-disabled UID 10001:10005 client
reported `generatedImageClean=true` and `inertTestDetected=true`, then exited 0.
The exact worker image/ID, synthetic label and mounts were rechecked before
stopping it. Test containers, signatures and socket volume are retained.
No patient input, application database or record storage was mounted.

References: [ClamAV container memory and signatures](https://docs.clamav.net/manual/Installing/Docker.html),
[ClamD configuration](https://github.com/Cisco-Talos/clamav/blob/main/etc/clamd.conf.sample),
[stream protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html).

Freshness tests use a synthetic Unix-socket daemon. They verify that stale or
future signatures stop document transfer, a fresh response restores access on
the same client, invalid replies release the scan slot, and expiry during a
scan discards its clean verdict. These tests do not replace the actual-daemon
probe: the supported ClamD version/date format must also work on Hermes.
