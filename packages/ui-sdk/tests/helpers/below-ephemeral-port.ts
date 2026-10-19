import { readFileSync } from "node:fs";

const KERNEL_DEFAULT_FLOOR = 32768;

/**
 * Bind a TCP listener that a worker probes from its own network namespace
 * below the kernel's ephemeral range. The worker draws its own loopback ports
 * from that range (a relay or proxy forward binding port 0, and every
 * connect's ephemeral source port), so a listener on a number from it can
 * coincide with a worker-local endpoint. A direct-connect probe then reads
 * "connected" without leaving the worker (#1945).
 */
export function belowEphemeral<T>(bind: (port: number) => T): T {
  // The caller's range need not be the worker's: a fresh network namespace
  // starts at the kernel default floor whatever the host configures.
  const low = Math.min(KERNEL_DEFAULT_FLOOR,
    Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0]));
  if (!(low > 10_000)) throw new Error(`No port range lies below the ephemeral range starting at ${low}`);
  for (let attempt = 0; ; attempt++) {
    const port = 10_000 + Math.floor(Math.random() * (low - 10_000));
    try { return bind(port); } catch (error) { if (attempt >= 64) throw error; }
  }
}
