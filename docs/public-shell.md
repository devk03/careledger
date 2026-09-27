# Public-only shell

The separate TypeScript/Express public shell is an honest project website, **not** the family workspace. It serves `/`, `/about`, `/privacy`, hashed static assets, public GitHub metadata and liveness/readiness. It has no sign-in, upload, record, managed, or MCP route. Unknown paths return 404. Do not enter or send personal health information to it.

It is built from a narrow Docker context and runs as UID 10001 with no database, record volume, AI key, or parser dependency. Its readiness check requires every JS, CSS, image and font listed in the current Vite manifest; only those assets can be served, so stale build files stay inaccessible. The default `Dockerfile` and `compose.yaml` still run the separate trusted-local Python community preview. Do not replace that runtime or point its record volume at this shell.

## Build and run locally

From the repository root:

```sh
docker build -f Dockerfile.public-shell -t adeno-public-shell:local .
docker run -d --name adeno-public-shell-local -p 127.0.0.1:4175:8080 --read-only --cap-drop ALL --security-opt no-new-privileges adeno-public-shell:local
```

Open `http://127.0.0.1:4175/`. `/health/live` proves the process responds; `/health/ready` checks that the built HTML and referenced assets are available. Neither endpoint means medical-record intake is ready. To stop the example container while preserving it, run `docker stop adeno-public-shell-local`.

For frontend-only development: run `npm ci` in `web/`, then `npm run build:public-shell` or `npm run test:public-shell`. For the server: run `npm ci` in `server/`, then `npm run build:public-shell` and `npm test -- test/publicShell.test.ts test/publicProjectStats.test.ts`. The separate output directories are `web/dist-public-shell/` and `server/dist-public-shell/`.

## Deployment boundary

Use `Dockerfile.public-shell` for this website only. Give it no database or record mounts and no provider secrets. TLS termination and an HTTPS hostname are required before a public deployment; verify proxy headers, caching, the emitted HSTS header, and route denials at the public URL. Browsers ignore HSTS on plain HTTP, so the header is not a substitute for HTTPS. A public-shell deployment does **not** authorize record upload or demonstrate complete end-to-end encryption. The [managed launch gates](managed-launch-gates.md) remain closed for real family data.
