# Parser sandbox smoke record

Synthetic-only local check on Docker Desktop Linux/arm64, 2026-09-24. No family records or application database were mounted. The commands below create test containers and socket volumes; `stop` leaves them in place. Do not substitute a real document. Choose a unique project and container name if repeating this check; the example names below were used already. Immediately before `docker kill`, verify the exact target is your synthetic test worker with `docker compose ... ps`. Never point these commands at an app or family-record container.

Build and start the opt-in parser preview:

```sh
docker build -f Dockerfile.parser -t adeno-parser:dev .
docker compose -f compose.parser.yaml -p adeno-parser-smoke-lock up -d --no-build
docker compose -f compose.parser.yaml -p adeno-parser-smoke-lock ps
```

Observed: worker UID/GID `10002:10003`; socket directory `10002:10003`, mode `0710`; live `parser.sock` `10002:10003`, mode `0660`; executable JS root-owned and not writable by the worker; Sharp/libvips loaded. The worker had no Docker network, ports, database mount, or record volume. Idle PID use was 12 under the revised 64-PID cap. A separate UID `10001` client in group `10003`, with the named socket volume mounted read-only and no network, submitted a generated 2×3 PNG and received `{"status":"safe","pageCount":1}`. This proves that socket access worked in this synthetic environment, not that arbitrary uploads are safe. A repeatable client command (choose a new `--name` if re-running) is:

```sh
docker run --name adeno-parser-smoke-client-1 --user 10001:10001 --group-add 10003 --network none --read-only --memory 256m --pids-limit 64 -v adeno-parser-smoke-lock_parser_socket:/run/adeno-parser:ro --entrypoint node adeno-parser:dev -e 'Promise.all([import("sharp"),import("./dist/ingest/parserSocket.js")]).then(async ([sharp,client])=>{const bytes=await sharp.default({create:{width:2,height:3,channels:3,background:{r:17,g:34,b:51}}}).png().toBuffer();const result=await client.createParserSocketInspector({socketPath:"/run/adeno-parser/parser.sock",trustedWorkerUid:10002,timeoutMs:5000}).inspect(bytes,"image/png");console.log(JSON.stringify(result));if(result.status!=="safe")process.exitCode=1}).catch(()=>{process.exitCode=1})'
```

Single-instance and crash check on that *test project only*:

```sh
docker run --name adeno-parser-lock-contender --user 10002:10003 --network none --read-only --memory 512m --pids-limit 64 -v adeno-parser-smoke-lock_parser_socket:/run/adeno-parser --entrypoint flock adeno-parser:dev -n /run/adeno-parser/worker.lock node dist/runParserWorker.js
docker compose -f compose.parser.yaml -p adeno-parser-smoke-lock ps
docker kill --signal SIGKILL adeno-parser-smoke-lock-parser-worker-1
docker compose -f compose.parser.yaml -p adeno-parser-smoke-lock start parser-worker
docker compose -f compose.parser.yaml -p adeno-parser-smoke-lock stop
```

Observed: the competing `flock` process exited `1` without moving the live socket. After the forced crash, the same worker container restarted and stayed running; its private volume contained `worker.lock`, a new `parser.sock`, and one archived `stale-*.sock`. No socket was deleted by the recovery code. The preview was stopped afterward, leaving the test containers and volumes recoverable.

Still required before medical uploads: test the target Linux host architecture and cgroup enforcement, automated health/restart policy, concurrent/large-image load, PDF inspection, ClamAV provisioning, authenticated upload and source grants, object/DB recovery, and an approved migration/cutover. Keep the parser disconnected from Express until these pass.
