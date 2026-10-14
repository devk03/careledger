// Independently invented protocol-overflow fixture; accepts no record paths.
process.stdin.resume();
process.stdout.write(Buffer.alloc(9 * 1024 * 1024, 0x41));
setInterval(() => {}, 1000);
setTimeout(() => process.exit(124), 60_000).unref();
