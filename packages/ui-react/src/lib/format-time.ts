/** Relative timestamp for list rows ("3m ago"); dates beyond a week. */
export function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const future = diff < 0;
  const distance = Math.abs(diff);
  if (distance < 60_000) return future ? "in less than a minute" : "just now";
  const minutes = future
    ? Math.ceil(distance / 60_000)
    : Math.floor(distance / 60_000);
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = future
    ? Math.ceil(distance / 3_600_000)
    : Math.floor(distance / 3_600_000);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = future
    ? Math.ceil(distance / 86_400_000)
    : Math.floor(distance / 86_400_000);
  if (days < 7) return future ? `in ${days}d` : `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}
