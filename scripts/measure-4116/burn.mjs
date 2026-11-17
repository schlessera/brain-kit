// A busy loop that ends by itself: node burn.mjs <seconds>
const end = Date.now() + Number(process.argv[2] ?? 120) * 1000;
for (;;) { const slice = Date.now() + 200; while (Date.now() < slice); if (Date.now() > end) process.exit(0); }
