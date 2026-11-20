/**
 * App-level recognition of typed-data documents: whole protocols whose requests the wallet can
 * describe as one action rather than a field list. A document an app recognizer does not claim
 * stays with the generic typed-data path (field dump, or the family table's blind reason when a
 * claim matches).
 */
import type {
  AssetFlow,
  BlindReason,
  HyperliquidAction,
  IntentSummary,
  IntentWarning,
  Verifiability,
} from "../index.ts";
import { recognizeHyperliquid } from "./hyperliquid.ts";
import type { TypedDataInput } from "./typed-data.ts";

export type AppRecognition = {
  readonly content: { readonly hyperliquid: HyperliquidAction };
  readonly summary: IntentSummary;
  readonly outflows: ReadonlyArray<AssetFlow>;
  readonly warnings: ReadonlyArray<IntentWarning>;
  readonly verifiability: Verifiability;
  readonly blind?: BlindReason;
};

export const recognizeApp = (json: TypedDataInput): AppRecognition | undefined =>
  recognizeHyperliquid(json);
