/** Credential-extraction scanning for user-approved Actors. Ordinary Actor data is not filtered. */
export function apifyCredentialRisk(value: unknown, hostSecrets: readonly string[] = []): boolean {
  const text = JSON.stringify(value) ?? "";
  if (hostSecrets.some(secret => secret.length >= 8 && text.includes(secret))) return true;
  if (/(?:apify_api_[A-Za-z0-9_-]{20,}|sk-ant-api\d+-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u.test(text)) return true;
  const credential = String.raw`(?:process\.env|\/proc\/[^ /]+\/environ|\.aws\/credentials|\.ssh\/id_(?:rsa|ed25519)|\b(?:APIFY_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)\b)`;
  const shell = new RegExp(String.raw`(?:^|[;&|\n])\s*(?:cat|head|tail|type|Get-Content)\s+[^\n]{0,100}${credential}`, "iu");
  const extraction = new RegExp(String.raw`(?:\b(?:dump|exfiltrate|steal|upload|send)\b|^\s*(?:please\s+)?(?:read|extract|retrieve|reveal)\b)[^\n]{0,100}${credential}`, "iu");
  const scan = (entry: unknown): boolean => {
    if (typeof entry === "string") return shell.test(entry) || extraction.test(entry);
    if (Array.isArray(entry)) return entry.some(scan);
    return !!entry && typeof entry === "object" && Object.values(entry).some(scan);
  };
  return scan(value);
}
