/** Conservative pre-proxy ingestion detection; this grants no command authority. */
export function commandTaintSource(tool: string, input: unknown): "fetching_command" | "unclassified_command" | null {
  if (tool !== "Bash" && tool !== "bash") return null;
  const command = input && typeof input === "object" ? (input as { command?: unknown }).command : undefined;
  if (typeof command !== "string" || !command.trim()) return "unclassified_command";
  // Only static, single-command words can establish the network-free case.
  // Substitutions, redirections, shell operators, quotes and environment
  // overrides remain opaque instead of borrowing a safe command's name.
  const staticWords = /^[A-Za-z0-9_./:=,@%+ -]+$/.test(command);
  let words = command.trim().split(/\s+/);
  if (words[0] === "rtk" && words[1] === "proxy") words = words.slice(2);
  const name = words[0]?.split("/").at(-1);
  if (["curl", "wget", "chromium", "chromium-browser", "google-chrome"].includes(name ?? "")) return "fetching_command";
  if (name === "brain" && ["scrape", "import"].includes(words[1] ?? "")) return "fetching_command";
  if (name === "git") {
    let index = 1;
    while (words[index]?.startsWith("-")) {
      const option = words[index++]!;
      if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(option)) index++;
    }
    if (["clone", "fetch"].includes(words[index] ?? "")) return "fetching_command";
  }
  // Keep this deliberately small. Unknown binaries and wrappers can execute
  // arbitrary network code; outward/read classification is not this proof.
  if (staticWords && (words[0] === "ls" || words[0] === "brain" && words[1] === "search")) return null;
  return "unclassified_command";
}
