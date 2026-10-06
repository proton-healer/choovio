/**
 * Core domain types for Choovio.
 *
 * Every fact Choovio reports carries its provenance (source URL, source kind,
 * time checked). A fact that could not be verified is represented explicitly as
 * `null` plus an entry in `unknowns` — never guessed.
 */

export type DataMode = "live" | "demo";

/** Where a piece of information came from. Used to separate evidence from marketing. */
export type SourceKind =
  | "manufacturer_spec" // structured spec data on the manufacturer's own site
  | "retailer_listing" // structured offer data on a retailer page (price, stock, seller)
  | "independent_review" // a review site not selling the product
  | "retailer_rating" // star ratings hosted by the retailer
  | "marketing_claim" // promotional copy (descriptions, taglines) — never treated as verified
  | "search_snippet"; // text from a search API result, not from the page itself

export interface Source {
  url: string;
  title?: string;
  kind: SourceKind;
  checkedAt: string; // ISO-8601
}

export type Availability = "in_stock" | "out_of_stock" | "preorder" | "limited" | "discontinued" | "unknown";

export interface Money {
  amount: number;
  currency: string; // ISO-4217
}

export interface Offer {
  price: Money | null;
  /** The "was" / list price when the page states one in structured data. */
  listPrice: Money | null;
  availability: Availability;
  seller: string | null;
  /** Shipping cost to the requested country, if stated. `amount: 0` means free shipping stated by the seller. */
  shipping: Money | null;
  shipsToCountry: boolean | null;
  deliveryDays: { min: number; max: number } | null;
  returnPolicy: string | null;
  returnDays: number | null;
  warranty: string | null;
  url: string;
  /** Size / colour / configuration this offer applies to, when the page lists variants. */
  variant: string | null;
  source: Source;
}

export interface SpecValue {
  name: string;
  value: string;
  source: Source;
}

export interface ReviewEvidence {
  kind: "independent_review" | "retailer_rating" | "search_snippet";
  summary: string;
  rating?: { value: number; best: number; count: number | null };
  url: string;
  source: Source;
}

export interface Complaint {
  text: string;
  /** Verbatim quote from the source page that supports this complaint. */
  quote: string;
  source: Source;
}

export interface SpecConflict {
  spec: string;
  values: { value: string; source: Source }[];
}

export interface ProductRecord {
  id: string;
  name: string;
  brand: string | null;
  model: string | null; // model number / MPN
  variant: string | null; // colour / size / capacity, when stated
  gtin: string | null;
  sku: string | null;
  imageUrl: string | null;
  offers: Offer[];
  specs: SpecValue[];
  marketingClaims: { text: string; source: Source }[];
  reviews: ReviewEvidence[];
  complaints: Complaint[];
  conflicts: SpecConflict[];
  /** Human-readable list of facts that could not be verified. */
  unknowns: string[];
  /** Security / data-quality warnings (e.g. suspected prompt injection on a page). */
  warnings: string[];
  /** True if a link is an affiliate link. Never used for ranking. */
  affiliate: boolean;
  dataMode: DataMode;
}

export type RequestKind = "search" | "compare_links" | "deal_check" | "gift" | "fit_check";

export interface Dimensions {
  widthCm?: number;
  depthCm?: number;
  heightCm?: number;
}

export interface ShoppingRequest {
  query: string;
  urls: string[];
  kind: RequestKind;
  budget: { max: number; min?: number } | null;
  currency: string | null;
  country: string | null; // ISO-3166 alpha-2
  preferences: string[];
  mustHave: string[];
  space?: Dimensions;
}

export interface ClarifyingQuestion {
  field: "budget" | "country" | "use" | "space" | "query";
  question: string;
}

export interface ScoredProduct {
  product: ProductRecord;
  bestOffer: Offer | null;
  score: number;
  fit: { reasons: string[]; concerns: string[] };
  withinBudget: boolean | null; // null = cannot be determined
  eligible: boolean; // false = cannot be recommended as best choice
  ineligibleReason?: string;
}

export interface CostBreakdown {
  productId: string;
  itemPrice: Money | null;
  shipping: Money | null;
  knownTotal: Money | null;
  unknownCosts: string[];
}

export interface ComparisonRow {
  productId: string;
  name: string;
  price: string;
  availability: string;
  delivery: string;
  warrantyReturns: string;
  rating: string;
  keySpecs: string;
}

export type ResultStatus = "complete" | "partial" | "insufficient";

export interface Recommendation {
  status: ResultStatus;
  dataMode: DataMode;
  checkedAt: string;
  request: ShoppingRequest;
  best: { productId: string; why: string[] } | null;
  alternatives: { productId: string; tradeoff: string }[];
  table: ComparisonRow[];
  costs: CostBreakdown[];
  avoidIf: { productId: string; reasons: string[] }[];
  links: { productId: string; name: string; url: string; affiliate: boolean }[];
  products: ScoredProduct[];
  sources: Source[];
  uncertainties: string[];
  disclosures: string[];
  /** Text written in Choovio's voice for human readers. */
  summary: string;
}
