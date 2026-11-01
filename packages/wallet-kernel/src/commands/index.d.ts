import type { CORE_METHODS, MethodName } from "@qntx/wallet/protocol";
import type { Handler } from "./context.ts";
/**
 * One typed entry per core protocol method; `ParamsOf`/`ResultOf` come from the METHODS validators,
 * so a handler whose shape drifts from the table fails to typecheck. kernel.ts composes this with
 * `status` (whose result validator composes every module) and each module's table.
 */
export declare const CORE_HANDLERS: {
    [M in keyof typeof CORE_METHODS & MethodName]: Handler<M>;
};
