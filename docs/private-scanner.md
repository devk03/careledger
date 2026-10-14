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
It rejects signatures over two days old at startup. This startup guard does not
prove freshness for an indefinitely running daemon; production still needs a
per-request freshness gate and a verified manual update/restart procedure.
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

References: [ClamAV container memory and signatures](https://docs.clamav.net/manual/Installing/Docker.html),
[ClamD configuration](https://github.com/Cisco-Talos/clamav/blob/main/etc/clamd.conf.sample),
[stream protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html).
