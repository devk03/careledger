import { spawn } from "node:child_process";

import { withLinuxAnonymousSeekableInput } from "./ingest/linuxAnonymousInput.js";
import { fictionalMinimalPdf } from "./synthetic/fictionalMinimalPdf.js";

/** qpdf --check is syntax evidence only, never a medical-file clearance. */
async function qpdfSyntaxCheck(bytes: Buffer): Promise<boolean> {
  return withLinuxAnonymousSeekableInput(bytes, (fd) => new Promise((resolve) => {
    const child = spawn("/usr/bin/qpdf", ["--check", "/proc/self/fd/3"], {
      shell: false, stdio: ["ignore", "pipe", "pipe", fd],
      env: { LANG: "C", PATH: "/usr/bin:/bin" },
    });
    let outputBytes = 0;
    let failed = false;
    const fail = () => { failed = true; child.kill("SIGKILL"); };
    const deadline = setTimeout(fail, 5000);
    for (const pipe of [child.stdout, child.stderr]) {
      pipe?.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > 8192) fail();
      });
      pipe?.on("error", fail);
    }
    child.once("error", fail);
    child.once("close", (code) => {
      clearTimeout(deadline);
      resolve(!failed && code === 0);
    });
  }));
}

try {
  const validSyntax = await qpdfSyntaxCheck(fictionalMinimalPdf());
  const malformedSyntax = await qpdfSyntaxCheck(
    Buffer.from("%PDF-1.4\nFICTIONAL MALFORMED DOCUMENT\n%%EOF\n", "ascii"));
  console.log(JSON.stringify({ probe: "fictional-only", validSyntax, malformedSyntax }));
  if (!validSyntax || malformedSyntax) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ probe: "fictional-only", validSyntax: false,
    malformedSyntax: false }));
  process.exitCode = 1;
}
