import type { MethodName, SPARK_METHODS } from "@qntx/wallet/protocol";
import type { Handler, VaultHooks } from "../../commands/context.ts";
export type SparkModule = {
    readonly vault: VaultHooks;
    readonly handlers: {
        [M in keyof typeof SPARK_METHODS & MethodName]: Handler<M>;
    };
};
export declare function createSparkModule(): SparkModule;
