/**
 * A stand-in extractor child for the bound tests (#3154). `startPage` picks
 * the misbehaviour, because the real child's only input is its request:
 * 1 sleeps for `offset` ms and then answers, 2 spins on the CPU, 3 allocates
 * until memory runs out, 4 floods stdout.
 */
const request = JSON.parse(process.argv[2] ?? "{}") as { startPage: number; offset: number };
for await (const _ of Bun.stdin.stream()) { /* drain the original */ }
if (request.startPage === 1) {
  // Fixture hold: a child that stays alive for `offset` ms. The bound cases
  // measure the extractor against it (its wall-clock kill, its queueing and
  // its cancellation), so the hold is real time by design.
  await Bun.sleep(request.offset);
  process.stdout.write(`${JSON.stringify({ outcome: "malformed" })}\n`);
} else if (request.startPage === 2) {
  for (;;) { /* spin until RLIMIT_CPU */ }
} else if (request.startPage === 3) {
  const hoard: Uint8Array[] = [];
  for (;;) hoard.push(new Uint8Array(16 << 20).fill(1));
} else if (request.startPage === 4) {
  process.stdout.write("x".repeat(4 << 20));
}

export {};
