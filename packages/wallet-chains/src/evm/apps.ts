/**
 * App-level recognition of typed-data documents: whole protocols whose requests the wallet can
 * describe as one action rather than a field list. A document an app recognizer does not claim
 * stays with the generic typed-data path (field dump, or the family table's blind reason when a
 * claim matches).
 */
import type {
  ApprovalChange,
  AssetFlow,
  BlindReason,
  HyperliquidAction,
  IntentSummary,
  IntentWarning,
  PolymarketContent,
  Verifiability,
} from "../index.ts";
import { recognizeHyperliquid } from "./hyperliquid.ts";
import { recognizePolymarket } from "./polymarket.ts";
import type { PolymarketContext, PolymarketDecodeCall } from "./polymarket.ts";
import type { TypedDataInput } from "./typed-data.ts";

export type AppRecognition = {
  readonly content:
    | { readonly hyperliquid: HyperliquidAction }
    | { readonly polymarket: PolymarketContent };
  readonly summary: IntentSummary;
  readonly outflows: ReadonlyArray<AssetFlow>;
  readonly approvals: ReadonlyArray<ApprovalChange>;
  readonly warnings: ReadonlyArray<IntentWarning>;
  readonly verifiability: Verifiability;
  readonly blind?: BlindReason;
};

export const recognizeApp = (
  json: TypedDataInput,
  context: PolymarketContext,
  decodeCall: PolymarketDecodeCall,
): AppRecognition | undefined => {
  const hyperliquid = recognizeHyperliquid(json);
  if (hyperliquid !== undefined) {
    return {
      content: { hyperliquid: hyperliquid.action },
      summary: hyperliquid.summary,
      outflows: [],
      approvals: [],
      warnings: [],
      verifiability: hyperliquid.verifiability,
    };
  }
  const polymarket = recognizePolymarket(json, context, decodeCall);
  return polymarket === undefined
    ? undefined
    : {
        content: polymarket.content,
        summary: polymarket.summary,
        outflows: polymarket.outflows,
        approvals: polymarket.approvals,
        warnings: [],
        verifiability: polymarket.verifiability,
        ...(polymarket.blind === undefined ? {} : { blind: polymarket.blind }),
      };
};
