/** Shell fixture: a match is witnessed only after successful search completion. */
export function searchWitnessScript(rg: string, marker: string, status: string, holdSeconds = 3): string {
 const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
 return `#!/bin/sh
case " $* " in
  *" sirens "*) ${quote(rg)} "$@"; code=$?; printf '%s\\n' "$code" > ${quote(status)}; if [ "$code" -eq 0 ]; then : > ${quote(marker)}; sleep ${holdSeconds}; fi; exit "$code";;
  *) exec ${quote(rg)} "$@";;
esac
`;
}
