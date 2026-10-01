/** One curated policy for schema defaults, scraper fallbacks and settings choices. */
export const JOB_BOARDS = [
  { source: "remoteok", defaultSelected: true },
  {
    source: "remotive", defaultSelected: false, blocked: true,
    // Its only API path is disallowed; selection cannot grant permission.
    caveat: "robots.txt disallows /api/*, the only path its adapter fetches; it needs the site's permission before it can run",
  },
  { source: "weworkremotely", defaultSelected: true },
  { source: "workingnomads", defaultSelected: true },
  { source: "builtin", defaultSelected: false, caveat: "client-rendered; needs a browser" },
  { source: "nodesk", defaultSelected: false, caveat: "client-rendered; needs a browser" },
  {
    source: "simplyhired", defaultSelected: false, usesQueries: true,
    // #33 measured rate limiting: the same URL answered 200 fifteen minutes later.
    caveat: "intermittent 403s (rate limiting) from the measured vantage point; see tests/fixtures/boards/README.md",
  },
  {
    source: "jobgether", defaultSelected: false,
    // #35 restored the API; politeness still limits it to its first page.
    caveat: "robots.txt disallows its API's query-string paging, so a run gets one page; see docs/decisions/scraping-politeness.md",
  },
  { source: "dice", defaultSelected: false, usesQueries: true, caveat: "client-rendered; needs a browser" },
  { source: "remotelyde", defaultSelected: true },
] as const satisfies readonly BoardPolicy[];

type BoardPolicy = {
  source: string;
  blocked?: boolean;
  usesQueries?: boolean;
} & ({ defaultSelected: true; caveat?: string } | { defaultSelected: false; caveat: string });

// Preserve the exported literal tuples while deriving their values from the
// policy. These types describe map/filter; they carry no second board list.
type SourceIds<T extends readonly BoardPolicy[]> = { readonly [K in keyof T]: T[K]["source"] };
type SelectedIds<T extends readonly BoardPolicy[]> = T extends readonly [infer First extends BoardPolicy, ...infer Rest extends readonly BoardPolicy[]]
  ? First["defaultSelected"] extends true ? readonly [First["source"], ...SelectedIds<Rest>] : SelectedIds<Rest>
  : readonly [];
type DisabledReasons<T extends readonly BoardPolicy[]> = {
  readonly [Board in T[number] as Board extends { defaultSelected: false; caveat: string } ? Board["source"] : never]: Board extends { caveat: infer Reason } ? Reason : never;
};

export const ALL_SOURCES = JOB_BOARDS.map((board) => board.source) as unknown as SourceIds<typeof JOB_BOARDS>;
/** Reliable feeds/category pages that need neither a browser nor a proxy. */
export const SOURCES = JOB_BOARDS.filter((board) => board.defaultSelected).map((board) => board.source) as unknown as SelectedIds<typeof JOB_BOARDS>;
/** Every default-off board carries its reason beside its selection policy. */
export const DISABLED_BY_DEFAULT = Object.fromEntries(JOB_BOARDS.filter((board) => !board.defaultSelected).map((board) => [board.source, "caveat" in board ? board.caveat : ""])) as DisabledReasons<typeof JOB_BOARDS>;

export function boardPolicy(source: string): BoardPolicy | undefined {
  return JOB_BOARDS.find((board) => board.source === source);
}
