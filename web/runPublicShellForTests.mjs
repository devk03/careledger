import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../server/dist-public-shell/runPublicShell.js",
  import.meta.url));
const webRoot = fileURLToPath(new URL("./dist-public-shell/", import.meta.url));
const child = spawn(process.execPath, [entry], {
  stdio: "inherit",
  env: {
    ADENO_SHELL_MODE: "public-only",
    ADENO_SHELL_WEB_ROOT: webRoot,
    PORT: "4174",
    NODE_ENV: "test",
    PATH: process.env.PATH ?? "",
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
