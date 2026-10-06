/**
 * Nevermined plan payments for POST /api/compare.
 *
 * Buyers who purchase the Choovio plan (e.g. through the agent's checkout link)
 * hold Nevermined credits, not USDC. They call the same endpoint with an x402
 * PAYMENT-SIGNATURE token whose scheme is "nvm:erc4337". Choovio verifies the
 * token with Nevermined, runs the research, and burns credits only when a
 * recommendation is returned — the same "pay only on success" rule as the
 * direct USDC route.
 *
 * Talks to Nevermined's REST facilitator directly (the same calls the
 * @nevermined-io/payments SDK makes) to avoid pulling in its dependency tree.
 */

export type NeverminedEnvironment = "live" | "sandbox";

export interface NeverminedSettings {
  apiKey: string;
  planId: string;
  agentId: string;
  environment: NeverminedEnvironment;
  /** Credits burned per successful comparison. */
  creditsPerRequest: number;
}

export interface PaymentRequired {
  x402Version: 2;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: Array<Record<string, unknown>>;
  extensions: Record<string, unknown>;
}

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
  agentRequestId?: string;
  agentRequest?: { agentRequestId?: string };
}

export interface SettleResult {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction?: string;
  network?: string;
  creditsRedeemed?: string;
  remainingBalance?: string;
}

export interface NeverminedFacilitator {
  verify(body: { paymentRequired: PaymentRequired; x402AccessToken: string; maxAmount: string }): Promise<VerifyResult>;
  settle(body: { paymentRequired: PaymentRequired; x402AccessToken: string; maxAmount: string; agentRequestId?: string }): Promise<SettleResult>;
}

const BACKEND: Record<NeverminedEnvironment, string> = {
  live: "https://api.live.nevermined.app",
  sandbox: "https://api.sandbox.nevermined.app",
};

/** Nevermined crypto plans settle on Base mainnet in live and Base Sepolia in sandbox. */
export const NVM_NETWORK: Record<NeverminedEnvironment, string> = { live: "eip155:8453", sandbox: "eip155:84532" };

/** The plan's accepts[] entry, as the SDK's buildPaymentRequired produces it. */
export function neverminedAccept(s: NeverminedSettings, httpVerb = "POST"): Record<string, unknown> {
  return { scheme: "nvm:erc4337", network: NVM_NETWORK[s.environment], planId: s.planId, extra: { version: "1", agentId: s.agentId, httpVerb } };
}

/** The PaymentRequired object Nevermined validates a token against. `endpoint` is the request path, as in the SDK. */
export function neverminedPaymentRequired(s: NeverminedSettings, endpoint: string, httpVerb = "POST"): PaymentRequired {
  return { x402Version: 2, resource: { url: endpoint }, accepts: [neverminedAccept(s, httpVerb)], extensions: {} };
}

/** True when a PAYMENT-SIGNATURE header carries a Nevermined plan token rather than a direct USDC payment. */
export function isNeverminedToken(header: string): boolean {
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepted?: { scheme?: unknown } };
    return typeof decoded.accepted?.scheme === "string" && decoded.accepted.scheme.startsWith("nvm:");
  } catch {
    return false;
  }
}

/** Facilitator backed by Nevermined's REST API. Non-2xx answers become invalid/failed results, never exceptions. */
export function httpNeverminedFacilitator(apiKey: string, environment: NeverminedEnvironment, fetchImpl: typeof fetch = fetch): NeverminedFacilitator {
  const post = async (path: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> => {
    const r = await fetchImpl(`${BACKEND[environment]}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    let data: Record<string, unknown> = {};
    try {
      data = (await r.json()) as Record<string, unknown>;
    } catch {
      // keep empty
    }
    return { ok: r.ok, data };
  };
  const reason = (d: Record<string, unknown>, fallback: string) => String(d.invalidReason ?? d.errorReason ?? d.message ?? fallback);
  return {
    async verify(body) {
      const { ok, data } = await post("/api/v1/x402/verify", body);
      if (!ok || data.isValid !== true) return { isValid: false, invalidReason: reason(data, "Payment verification failed") };
      return data as unknown as VerifyResult;
    },
    async settle(body) {
      const { ok, data } = await post("/api/v1/x402/settle", body);
      // A 200 without success:true is not a settlement either.
      if (!ok || data.success !== true) return { success: false, errorReason: reason(data, "Settlement failed") };
      return data as unknown as SettleResult;
    },
  };
}

export const encodeHeader = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
