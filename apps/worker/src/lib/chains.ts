/**
 * Chain / franchise detection (PRD 6.1 is_chain; audit finding 3).
 *
 * Brand entries prefixed with "=" (e.g. "=target", "=shell") are common
 * words: they match only when they ARE the whole normalized name, never as a
 * prefix, so "Target Pest Control" and "Shell Point Plumbing" stay local.
 *
 * Three independent signals, each recorded as businesses.chain_reason:
 *   known_brand    — the normalized name STARTS WITH a brand from
 *                    KNOWN_CHAIN_BRANDS (token-prefix, never substring, so
 *                    "Great Clips Nampa" matches and "Clip Joint" does not)
 *   url_shape      — the GBP website link is a store-locator page
 *                    (isChainLikeUrl)
 *   multi_location — the same normalized name at ≥3 distinct place ids,
 *                    inside one search (Scout) or across the workspace
 *                    (DataStore.upsertBusiness)
 *
 * Chains never buy a local rebuild: exclude_chains defaults to true and
 * scoring caps a chain's sellability (CHAIN_SELLABILITY_CAP).
 */
import type { ChainReason } from "@rapidforge/shared";

export type { ChainReason };

/**
 * Same normalized name at ≥ this many distinct place ids → every one is a
 * chain (within one search in Scout; across the workspace in the store).
 */
export const MULTI_LOCATION_CHAIN_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

/** Legal / entity suffix tokens dropped from the END of a name. */
const ENTITY_SUFFIX_TOKENS = new Set([
  "llc",
  "l l c",
  "inc",
  "incorporated",
  "co",
  "corp",
  "corporation",
  "ltd",
  "limited",
  "lp",
  "llp",
  "pllc",
  "pc",
  "pa",
  "dba",
]);

/**
 * Canonical form for grouping and brand matching: lowercase; drop a
 * location suffix (" - Boise", " – Nampa", " | Meridian", " #123",
 * "(Boise)", " of Boise" at the end); drop a leading "the"; punctuation →
 * space; drop trailing LLC/Inc/Co…; collapse whitespace.
 *
 *   "Great Clips - Nampa #4471"  → "great clips"
 *   "Mr. Rooter Plumbing of Boise" → "mr rooter plumbing"
 *   "The Home Depot"             → "home depot"
 *   "Boise Plumbing Co."         → "boise plumbing"
 */
export function normalizeBusinessName(name: string): string {
  let s = name.toLowerCase();
  // Location / unit suffixes introduced by a separator or store number.
  s = s.replace(/\s+(?:-|–|—|\||#|:)\s*.*$/, "");
  s = s.replace(/\s*#\s*\d+.*$/, "");
  s = s.replace(/\s*\([^)]*\)\s*$/, "");
  // Possessive and punctuation → spaces.
  s = s.replace(/['’]s\b/g, "s").replace(/[^a-z0-9]+/g, " ").trim();
  s = s.replace(/^the\s+/, "");
  // "<brand> of <city>" — keep the brand part ("at"/"in" are kept: "Home
  // Services at The Home Depot" is the brand).
  s = s.replace(/\s+of\s+[a-z0-9 ]+$/, "");
  let tokens = s.split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && ENTITY_SUFFIX_TOKENS.has(tokens[tokens.length - 1]!)) {
    tokens.pop();
  }
  return tokens.join(" ");
}

// ---------------------------------------------------------------------------
// Known brands — national and large regional chains / franchises for the
// verticals RapidForge targets. Stored normalized (see above). Prefix
// matched, so "great clips" also covers "Great Clips Nampa Marketplace".
// ---------------------------------------------------------------------------

const RAW_CHAIN_BRANDS: readonly string[] = [
  // Hair / beauty / waxing / nails
  "ulta beauty",
  "ulta",
  "sephora",
  "supercuts",
  "sport clips",
  "sport clips haircuts",
  "sportclips",
  "great clips",
  "smartstyle",
  "smart style",
  "fantastic sams",
  "cost cutters",
  "hair cuttery",
  "first choice haircutters",
  "roosters mens grooming",
  "roosters",
  "floyds 99",
  "floyds barbershop",
  "lady janes",
  "cookie cutters",
  "snip its",
  "pigtails crewcuts",
  "sharkeys cuts for kids",
  "regis salon",
  "=regis",
  "mastercuts",
  "hair masters",
  "hairmasters",
  "signature style",
  "holiday hair",
  "borics",
  "famous hair",
  "paul mitchell the school",
  "paul mitchell school",
  "paul mitchell schools",
  "aveda institute",
  "aveda arts sciences institute",
  "toni guy",
  "drybar",
  "blo blow dry bar",
  "european wax center",
  "european wax",
  "radiant waxing",
  "waxing the city",
  "=wax center",
  "sugared bronzed",
  "benefit brow bar",
  "amazing lash studio",
  "the lash lounge",
  "=lash lounge",
  "deka lash",
  "massage envy",
  "hand and stone",
  "hand stone",
  "elements massage",
  "the joint chiropractic",
  "joint chiropractic",
  "sola salon studios",
  "sola salons",
  "phenix salon suites",
  "salons by jc",
  "my salon suite",
  "palm beach tan",
  "sun tan city",
  "hollywood tans",
  "regal nails",
  "=nail bar",
  // Trades / home services
  "roto rooter",
  "mr rooter",
  "mr rooter plumbing",
  "benjamin franklin plumbing",
  "ars rescue rooter",
  "=ars",
  "one hour heating",
  "one hour heating air conditioning",
  "one hour air conditioning",
  "aire serv",
  "mr electric",
  "mister sparky",
  "mr appliance",
  "mr handyman",
  "handyman connection",
  "ace handyman services",
  "horizon services",
  "service experts",
  "=sila",
  "lennox stores",
  "american residential services",
  "bluefrog plumbing",
  "zoom drain",
  "the grounds guys",
  "grounds guys",
  "rainbow restoration",
  "rainbow international",
  "servpro",
  "servicemaster",
  "servicemaster restore",
  "servicemaster clean",
  "paul davis restoration",
  "paul davis",
  "puroclean",
  "=belfor",
  "dryer vent wizard",
  "window genie",
  "fish window cleaning",
  "shelfgenie",
  "glass doctor",
  "precision door service",
  "precision garage door",
  "overhead door",
  "neighborly",
  "dream doors",
  "closets by design",
  "california closets",
  "bath fitter",
  "re bath",
  "rebath",
  "west shore home",
  "leaffilter",
  "leaf filter",
  "leafguard",
  "leaf guard",
  "renewal by andersen",
  "champion windows",
  "window world",
  "window nation",
  "power home remodeling",
  "stanley steemer",
  "chem dry",
  "oxi fresh",
  "zerorez",
  "=coit",
  "terminix",
  "orkin",
  "rentokil",
  "=aptive",
  "aptive environmental",
  "mosquito joe",
  "mosquito squad",
  "mosquito authority",
  "trugreen",
  "lawn doctor",
  "weed man",
  "the lawn squad",
  "molly maid",
  "merry maids",
  "=the maids",
  "the cleaning authority",
  "cleaning authority",
  "two maids",
  "two maids a mop",
  "maidpro",
  "1 800 got junk",
  "1800gotjunk",
  "junk king",
  "college hunks hauling junk",
  "college hunks",
  "two men and a truck",
  "u haul",
  "uhaul",
  "certapro painters",
  "certapro",
  "five star painting",
  "wow 1 day painting",
  "fresh coat painters",
  "mr rooter plumbing",
  "home services at the home depot",
  "home depot",
  "the home depot",
  "lowes",
  "lowes home improvement",
  "ace hardware",
  "sherwin williams",
  "pella windows",
  "andersen windows",
  "=angi",
  "angie s list",
  "homeadvisor",
  // Dental / medical
  "aspen dental",
  "western dental",
  "pacific dental services",
  "heartland dental",
  "smile brands",
  "bright now dental",
  "monarch dental",
  "castle dental",
  "gentle dental",
  "affordable dentures",
  "affordable dentures implants",
  "comfort dental",
  "kool smiles",
  "smile direct club",
  "smiledirectclub",
  "clearchoice",
  "clear choice dental implant",
  "familia dental",
  "midwest dental",
  "sonrava",
  "dental works",
  "dentalworks",
  "coast dental",
  "invisalign",
  "myeyedr",
  "lenscrafters",
  "pearle vision",
  "visionworks",
  "americas best",
  "americas best contacts eyeglasses",
  "eyemart express",
  "target optical",
  "walmart vision",
  "concentra",
  "fastmed",
  "medexpress",
  "carenow",
  "patient first",
  "minuteclinic",
  "=cvs",
  "walgreens",
  "rite aid",
  "banfield",
  "vca animal hospital",
  "=vca",
  "petsmart",
  "petco",
  // Fitness
  "planet fitness",
  "anytime fitness",
  "orangetheory",
  "orangetheory fitness",
  "orange theory",
  "snap fitness",
  "crunch fitness",
  "=crunch",
  "24 hour fitness",
  "la fitness",
  "golds gym",
  "gold s gym",
  "club pilates",
  "pure barre",
  "cyclebar",
  "yogasix",
  "yoga six",
  "stretchlab",
  "row house",
  "rumble boxing",
  "=akt",
  "=bft",
  "f45",
  "f45 training",
  "burn boot camp",
  "9round",
  "9 round",
  "the bar method",
  "barre3",
  "corepower yoga",
  "ymca",
  "the ymca",
  "=curves",
  "jazzercise",
  "d1 training",
  "the exercise coach",
  "the camp transformation center",
  "eos fitness",
  "vasa fitness",
  "chuze fitness",
  "=in shape",
  "lifetime fitness",
  "=life time",
  "=equinox",
  "ufc gym",
  "title boxing club",
  "mayweather boxing fitness",
  "ilovekickboxing",
  "i love kickboxing",
  "workout anytime",
  "retro fitness",
  "blink fitness",
  "youfit",
  "fitness 19",
  "=club fitness",
  "the little gym",
  "=my gym",
  // Restaurants / food
  "mcdonalds",
  "burger king",
  "wendys",
  "starbucks",
  "dutch bros",
  "dutch bros coffee",
  "=subway",
  "jersey mikes",
  "jimmy johns",
  "firehouse subs",
  "dominos",
  "dominos pizza",
  "pizza hut",
  "papa johns",
  "papa murphys",
  "little caesars",
  "marcos pizza",
  "mod pizza",
  "blaze pizza",
  "chipotle",
  "chipotle mexican grill",
  "qdoba",
  "taco bell",
  "taco johns",
  "del taco",
  "cafe rio",
  "costa vida",
  "panda express",
  "panera bread",
  "chick fil a",
  "popeyes",
  "kfc",
  "raising canes",
  "zaxbys",
  "wingstop",
  "buffalo wild wings",
  "sonic drive in",
  "=sonic",
  "arbys",
  "carls jr",
  "jack in the box",
  "five guys",
  "in n out burger",
  "in n out",
  "culvers",
  "freddys frozen custard",
  "shake shack",
  "whataburger",
  "dairy queen",
  "dq grill chill",
  "baskin robbins",
  "cold stone creamery",
  "dunkin",
  "dunkin donuts",
  "krispy kreme",
  "einstein bros bagels",
  "ihop",
  "dennys",
  "waffle house",
  "cracker barrel",
  "applebees",
  "chilis",
  "olive garden",
  "red lobster",
  "outback steakhouse",
  "texas roadhouse",
  "red robin",
  "bjs restaurant",
  "cheesecake factory",
  "the cheesecake factory",
  "pf changs",
  "noodles company",
  "noodles and company",
  "jamba",
  "jamba juice",
  "smoothie king",
  "tropical smoothie cafe",
  "crumbl",
  "crumbl cookies",
  "nothing bundt cakes",
  "insomnia cookies",
  "7 eleven",
  "7eleven",
  "maverik",
  "jacksons food stores",
  "=jacksons",
  "=chevron",
  "=shell",
  "=sinclair",
  // Auto
  "jiffy lube",
  "valvoline instant oil change",
  "valvoline",
  "take 5 oil change",
  "=take 5",
  "grease monkey",
  "oil can henrys",
  "=midas",
  "midas auto",
  "midas auto service",
  "meineke",
  "meineke car care center",
  "aamco",
  "aamco transmissions",
  "firestone",
  "firestone complete auto care",
  "goodyear",
  "goodyear auto service",
  "les schwab",
  "les schwab tire center",
  "discount tire",
  "big o tires",
  "tires plus",
  "ntb",
  "national tire battery",
  "pep boys",
  "=monro",
  "monro auto service",
  "=mavis",
  "mavis discount tire",
  "tire discounters",
  "=point s",
  "christian brothers automotive",
  "=tuffy",
  "tuffy tire auto service",
  "car x",
  "carx",
  "precision tune auto care",
  "maaco",
  "caliber collision",
  "gerber collision",
  "gerber collision glass",
  "service king",
  "crash champions",
  "abra auto body",
  "safelite",
  "safelite autoglass",
  "glass america",
  "ziebart",
  "mister car wash",
  "mr car wash",
  "quick quack car wash",
  "quick quack",
  "tommys express",
  "tommys express car wash",
  "autozone",
  "o reilly auto parts",
  "oreilly auto parts",
  "napa auto parts",
  "=napa",
  "advance auto parts",
  "carmax",
  "carvana",
  "enterprise rent a car",
  "=hertz",
  "=avis",
  "=budget car rental",
  "u haul neighborhood dealer",
  // Big box / retail that shows up in trade and beauty searches
  "walmart",
  "walmart supercenter",
  "=target",
  "costco",
  "costco wholesale",
  "sams club",
  "best buy",
  "=staples",
  "office depot",
  "fedex office",
  "the ups store",
  "ups store",
  "batteries plus",
  "=verizon",
  "t mobile",
  "=at t",
  "=att",
  "xfinity",
  "=spectrum",
  "=amazon",
  "dollar tree",
  "dollar general",
  "family dollar",
  "harbor freight",
  "harbor freight tools",
  "tractor supply",
  "tractor supply co",
  "=michaels",
  "hobby lobby",
  "=joann",
  "bed bath beyond",
  "kohls",
  "jcpenney",
  "macys",
  "marshalls",
  "tj maxx",
  "ross dress for less",
  "=ross",
  "=goodwill",
  "the salvation army",
  "salvation army",
];

/** Normalized, deduplicated ("The X" and "X" collapse to one entry). */
export const KNOWN_CHAIN_BRANDS: readonly string[] = [
  ...new Set(
    RAW_CHAIN_BRANDS.map((entry) =>
      entry.startsWith("=")
        ? `=${normalizeBusinessName(entry.slice(1))}`
        : normalizeBusinessName(entry),
    ),
  ),
];

interface BrandEntry {
  tokens: string[];
  /** "=" entries: whole-name match only. */
  exact: boolean;
}

const BRAND_ENTRIES: readonly BrandEntry[] = KNOWN_CHAIN_BRANDS
  .filter((b) => b.replace(/^=/, "").length > 0)
  .map((b) => ({
    exact: b.startsWith("="),
    tokens: b.replace(/^=/, "").split(" "),
  }))
  // Longest first so the most specific brand wins the reason label.
  .sort((a, b) => b.tokens.length - a.tokens.length);

/**
 * The brand whose tokens are a prefix of the normalized name, or null.
 * Whole-token prefix: "sport clips haircuts of nampa" ✓, "clip joint" ✗,
 * "supercutsy" ✗. Exact-only ("=") brands must equal the whole name.
 */
export function matchKnownChainBrand(name: string): string | null {
  const tokens = normalizeBusinessName(name).split(" ").filter(Boolean);
  if (tokens.length === 0) return null;
  outer: for (const brand of BRAND_ENTRIES) {
    if (brand.tokens.length > tokens.length) continue;
    if (brand.exact && brand.tokens.length !== tokens.length) continue;
    for (let i = 0; i < brand.tokens.length; i += 1) {
      if (brand.tokens[i] !== tokens[i]) continue outer;
    }
    return brand.tokens.join(" ");
  }
  return null;
}

export function isKnownChainName(name: string): boolean {
  return matchKnownChainBrand(name) !== null;
}

// ---------------------------------------------------------------------------
// URL shape
// ---------------------------------------------------------------------------

/** Host labels that mean "this is the brand's store directory". */
const LOCATOR_SUBDOMAINS = new Set([
  "salons",
  "salon",
  "locations",
  "location",
  "stores",
  "store",
  "local",
  "shops",
  "clinics",
  "offices",
  "restaurants",
  "centers",
  "studios",
  "gyms",
]);

/** Path segments that mean "a page about one of many locations". */
const LOCATOR_SEGMENTS = new Set([
  "stores",
  "store",
  "locations",
  "location",
  "l",
  "nearme",
  "near-me",
  "store-locator",
  "storelocator",
  "locator",
  "find-a-store",
  "find-a-location",
]);

/** Name tokens too generic to tie a domain to a business. */
const WEAK_NAME_TOKENS = new Set([
  "the",
  "and",
  "of",
  "at",
  "in",
  "for",
  "a",
  "an",
  "home",
  "services",
  "service",
  "company",
  "group",
  "center",
  "centers",
  "clinic",
  "salon",
  "salons",
  "studio",
  "studios",
  "shop",
  "shops",
  "store",
  "stores",
  "plumbing",
  "plumber",
  "plumbers",
  "heating",
  "cooling",
  "air",
  "hvac",
  "electric",
  "electrical",
  "roofing",
  "dental",
  "dentistry",
  "fitness",
  "gym",
  "auto",
  "automotive",
  "repair",
  "care",
  "hair",
  "nails",
  "beauty",
  "barber",
  "barbershop",
  "pizza",
  "grill",
  "cafe",
  "restaurant",
  "boise",
  "nampa",
  "meridian",
  "caldwell",
  "eagle",
  "kuna",
  "idaho",
]);

/** Public suffixes with two labels we need to peel (co.uk style). */
const TWO_LABEL_SUFFIXES = new Set(["co.uk", "com.au", "co.nz", "com.mx"]);

export function registrableDomainLabel(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, "").split(".");
  if (labels.length < 2) return labels[0] ?? "";
  const lastTwo = labels.slice(-2).join(".");
  const idx = TWO_LABEL_SUFFIXES.has(lastTwo) ? labels.length - 3 : labels.length - 2;
  return labels[Math.max(0, idx)] ?? "";
}

/** True when the domain plausibly belongs to this business. */
export function domainSharesNameToken(domainLabel: string, businessName: string): boolean {
  const label = domainLabel.replace(/[^a-z0-9]/g, "");
  if (label.length < 3) return false;
  const tokens = normalizeBusinessName(businessName)
    .split(" ")
    .filter((t) => t.length >= 3 && !WEAK_NAME_TOKENS.has(t));
  if (tokens.length === 0) return false;
  // The domain is the squashed name, or starts with its first strong token.
  const squashed = tokens.join("");
  if (squashed.includes(label) && label.length >= 4) return true;
  if (label.startsWith(tokens[0]!) && tokens[0]!.length >= 4) return true;
  return tokens.some((t) => t.length >= 5 && label.includes(t));
}

export interface ChainUrlSignals {
  locatorSubdomain: boolean;
  locatorPath: boolean;
  numericStoreId: boolean;
  domainSharesName: boolean;
  /** utm_campaign=gmb / utm_source=gmb|gbp — GBP-managed link tracking. */
  gbpTracking: boolean;
}

export function chainUrlSignals(
  website: string,
  businessName: string,
): ChainUrlSignals | null {
  let url: URL;
  try {
    url = new URL(website.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const labels = host.replace(/^www\./, "").split(".");
  const locatorSubdomain =
    labels.length >= 3 && LOCATOR_SUBDOMAINS.has(labels[0]!);
  const segments = url.pathname
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  const locatorPath = segments.some((s) => LOCATOR_SEGMENTS.has(s));
  // A store/unit number after the first segment: a bare 2–4 or 6-digit
  // segment, a slug ending in -1234, or an explicit st/store/loc/unit
  // prefix. A 5-digit number is a zip code, not a store id.
  const numericStoreId = segments.some(
    (s, i) =>
      i > 0 &&
      (/^(?:\d{2,4}|\d{6})$/.test(s) ||
        /(?:^|[-_])(?:\d{2,4}|\d{6})$/.test(s) ||
        /(?:^|[-_])(?:st|store|loc|unit)-?\d{2,6}$/.test(s)),
  );
  const utm = url.searchParams;
  const gbpTracking = [
    utm.get("utm_campaign"),
    utm.get("utm_source"),
    utm.get("utm_medium"),
  ].some((v) => v !== null && /^(gmb|gbp|google[-_ ]?(my[-_ ]?business|business[-_ ]?profile)|googlemybusiness)$/i.test(v));
  return {
    locatorSubdomain,
    locatorPath,
    numericStoreId,
    domainSharesName: domainSharesNameToken(registrableDomainLabel(host), businessName),
    gbpTracking,
  };
}

/**
 * Store-locator URL heuristic. True when
 *   - the host is a salons./locations./stores./local. (…) subdomain; or
 *   - the path has a locator segment (/stores/, /locations/, /l/, /nearme/,
 *     /store-locator/) and the domain is NOT the business's own (a DBA
 *     franchisee pointing at the franchisor's directory); or
 *   - the domain is not the business's own and the path carries a numeric
 *     store id; or
 *   - the brand's own domain + locator path + a numeric store id.
 * utm_campaign=gmb-style tracking is weak: it never flags alone, it only
 * tips the one borderline case (own domain + locator path, no store id),
 * which is what separates a one-location salon's /locations/ "find us"
 * page (not a chain) from a franchise location page carrying GBP tracking.
 */
export function isChainLikeUrl(
  website: string | null | undefined,
  businessName: string,
): boolean {
  if (!website) return false;
  const s = chainUrlSignals(website, businessName);
  if (!s) return false;
  if (s.locatorSubdomain) return true;
  if (!s.domainSharesName && (s.locatorPath || s.numericStoreId)) return true;
  if (s.locatorPath && s.numericStoreId) return true;
  if (s.locatorPath && s.gbpTracking) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Combined per-record detection
// ---------------------------------------------------------------------------

export interface ChainDetection {
  isChain: boolean;
  reason: ChainReason | null;
}

/** Brand list wins the label, then URL shape, then multi-location. */
export function detectChain(
  name: string,
  website: string | null | undefined,
  multiLocation: boolean,
): ChainDetection {
  if (isKnownChainName(name)) return { isChain: true, reason: "known_brand" };
  if (isChainLikeUrl(website, name)) return { isChain: true, reason: "url_shape" };
  if (multiLocation) return { isChain: true, reason: "multi_location" };
  return { isChain: false, reason: null };
}
