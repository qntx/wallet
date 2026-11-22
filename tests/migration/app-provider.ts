/**
 * Writing an app provider: a minimal `AppDefinition` composed with `createApps`, importing only the
 * public package entries — `@qntx/wallet-engine/apps`, `@qntx/wallet-engine` and `@qntx/wallet`,
 * never engine `src` paths. Compiled only; the engine README's "Writing an app provider" section
 * describes the same surface.
 */
import type { Wallet } from "@qntx/wallet";
import { readJson } from "@qntx/wallet-engine";
import type {
  AppContext,
  AppDefinition,
  AppFlow,
  AppGroup,
  AppInstance,
  AppProvider,
  AppSocket,
  CreateAppsOptions,
} from "@qntx/wallet-engine/apps";
import { createApps } from "@qntx/wallet-engine/apps";

const ID = "example-notes";

export class ExampleNotesError extends Error {
  readonly category: "busy" | "unlock-required" | "unavailable" | "invalid-input" | "remote";
  constructor(category: ExampleNotesError["category"], message: string) {
    super(message);
    this.name = "ExampleNotesError";
    this.category = category;
  }
}

/** The app's own group-state fields — a detail key may not redefine a controller field. */
export type ExampleNotesDetail = {
  readonly step?: "register" | "verify";
  readonly handle?: string;
};

export type ExampleNotesApi = {
  /** The group's registered handle — `undefined` while locked or not enabled. */
  readonly handle: (group: AppGroup) => string | undefined;
  /** Change the handle — a provider flow under the controller's busy/unlock guards. */
  readonly rename: (group: AppGroup, handle: string) => Promise<void>;
  /** Publish a note — refused unless eligibility still reports the app `available`. */
  readonly publish: (group: AppGroup, body: string) => Promise<void>;
};

const error: AppProvider<ExampleNotesDetail>["error"] = (category, message) =>
  new ExampleNotesError(category, message);

const setTimer = (ms: number, fn: () => void): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const readHandle = (raw: Uint8Array | undefined): string | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  /* `readJson` answers `undefined` for bytes that are not JSON — a torn record reads as absent. */
  const parsed = readJson(raw);
  if (typeof parsed !== "object" || parsed === null || !("handle" in parsed)) {
    return undefined;
  }
  const { handle } = parsed;
  return typeof handle === "string" ? handle : undefined;
};

export const exampleNotes = (config: {
  readonly endpoint: string;
}): AppDefinition<typeof ID, ExampleNotesApi, ExampleNotesDetail> => {
  const endpoint = new URL(config.endpoint); // config is validated synchronously, not per call

  const create = (
    context: AppContext<ExampleNotesDetail>,
  ): AppInstance<ExampleNotesApi, ExampleNotesDetail> => {
    const reconcile = async (group: AppGroup, flow: AppFlow<ExampleNotesDetail>): Promise<void> => {
      const handle = readHandle(await context.storage.get(group, "registration"));
      flow.write(
        handle === undefined
          ? { status: "disabled", step: undefined, requestId: undefined, handle: undefined }
          : { status: "enabled", step: undefined, handle },
      );
    };

    const provider: AppProvider<ExampleNotesDetail> = {
      error,
      groups: context.storage.groups,
      reconcile,
      enable: async (group, flow) => {
        if (!flow.current().termsAcknowledged) {
          throw error("invalid-input", "the terms are not acknowledged");
        }
        flow.write({ status: "enabling", step: "register" });
        const handle = `user-${context.random(3)[0]?.toString(16) ?? "0"}`;
        await context.storage.put(group, "registration", encode({ handle }));
        flow.write({ status: "enabled", step: undefined, handle });
      },
      // oxlint-disable-next-line typescript/require-await -- renew always refuses; the Promise signature is the interface's.
      renew: async () => {
        throw error("invalid-input", "a registration never expires — nothing to renew");
      },
      disable: async (group, options, flow) => {
        if (options.revoke) {
          context.logger.warn("example-notes keeps nothing server-side to revoke");
        }
        await context.storage.delete(group, "registration");
        flow.write({ status: "disabled", step: undefined, handle: undefined });
      },
      cancel: async (group, flow) => {
        const { requestId } = flow.current();
        if (requestId !== undefined) {
          context.requests.reject(requestId);
        }
        await reconcile(group, flow);
      },
    };

    const api: ExampleNotesApi = {
      handle: (group) => context.groupState(group)?.handle,
      rename: async (group, handle) =>
        context.flow(group, async (flow) => {
          if (flow.current().status !== "enabled") {
            throw error("invalid-input", "the group is not enabled");
          }
          await context.storage.put(group, "registration", encode({ handle }));
          flow.write({ handle });
        }),
      publish: async (group, body) => {
        if (context.availability() !== "available") {
          throw error("unavailable", "the app is not available in this jurisdiction");
        }
        const response = await context.fetch(new URL("/notes", endpoint), {
          method: "POST",
          body: JSON.stringify({ group: group.groupIndex, body }),
        });
        if (!response.ok) {
          throw new ExampleNotesError("remote", `publish answered ${response.status}`);
        }
      },
    };
    return { api, provider };
  };

  return { id: ID, enableWhen: ["available"], create };
};

/** Host composition: the definition inside `createApps`, its group state typed by the list. */
export async function createExampleApps(params: {
  readonly wallet: Wallet;
  readonly requests: CreateAppsOptions["requests"];
  readonly networks: CreateAppsOptions["networks"];
  readonly openStore: CreateAppsOptions["openStore"];
  readonly group: AppGroup;
}): Promise<{ handle: string | undefined }> {
  const { wallet, group } = params;
  const apps = createApps({
    wallet,
    requests: params.requests,
    networks: params.networks,
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    setTimer,
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    // oxlint-disable-next-line eslint/no-console -- the example logs to the console.
    logger: { warn: (message, err) => console.warn(message, err) },
    openStore: params.openStore,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every platform's WebSocket is an AppSocket; the DOM types just won't say so.
    socket: (url) => new WebSocket(url) as AppSocket,
    gateway: { url: "https://gateway.example.com" },
    apps: [exampleNotes({ endpoint: "https://notes.example.com" })],
  });
  await apps.controller.acknowledgeTerms(group, ID);
  await apps.controller.enable(group, ID);
  return {
    /* The groups map is typed by the listed definitions: `handle` reads off the detail with
       no cast. */
    handle:
      apps.controller.getState().groups[`${group.walletId}/${group.groupIndex}`]?.["example-notes"]
        ?.handle,
  };
}
