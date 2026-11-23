/**
 * The Worker environment: `wrangler.jsonc`'s generated vars plus the optional values no environment
 * requires — the 0x integrator fee, staging's Jupiter and CoinGecko keys, and the push secrets.
 * Absent ones disable the feature rather than failing a deploy (`secrets.required` stays push-free
 * so deploy-check has nothing new to demand). A leaf module so `upstream.ts` and `push/runtime.ts`
 * can name the env without closing a cycle through `worker.ts`.
 */
type OptionalEnv = {
  readonly ZEROX_FEE_RECIPIENT?: string;
  readonly ZEROX_FEE_BPS?: string;
  readonly JUPITER_API_KEY?: string;
  readonly COINGECKO_API_KEY?: string;
  readonly PUSH_SEAL_KEY?: string;
  readonly APNS_KEY?: string;
  readonly APNS_KEY_ID?: string;
  readonly APNS_TEAM_ID?: string;
  readonly APNS_TOPIC?: string;
  readonly FCM_SERVICE_ACCOUNT?: string;
  readonly ALCHEMY_NOTIFY_TOKEN?: string;
  readonly ALCHEMY_WEBHOOKS?: string;
};

export type WorkerEnv = (Cloudflare.StagingEnv | Cloudflare.ProductionEnv) & OptionalEnv;
