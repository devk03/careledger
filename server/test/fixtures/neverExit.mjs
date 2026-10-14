// Fictional process-lifetime fixture. It never handles document bytes.
process.stdin.resume();
setInterval(() => {}, 1000);
// Independent safety bound if a failed test loses its supervising process.
setTimeout(() => process.exit(124), 60_000).unref();
