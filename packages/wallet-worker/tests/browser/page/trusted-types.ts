/**
 * The Trusted Types setup the README documents for pages with `require-trusted-types-for 'script'`:
 * a `default` policy whose `createScriptURL` admits only the bundled kernel worker on this origin.
 * Bundlers detect the worker only in the literal `new Worker(new URL(…))` form, so the library
 * cannot wrap that URL in a named policy itself.
 */
type TrustedTypePolicyFactory = {
  readonly createPolicy: (
    name: string,
    rules: { readonly createScriptURL: (input: string) => string },
  ) => unknown;
};

const KERNEL_WORKER = /\/kernel\.worker[^/]*\.js$/;

/** Installs the policy where the browser supports Trusted Types; a no-op elsewhere. */
export function installKernelWorkerPolicy(): void {
  const page: typeof globalThis & { readonly trustedTypes?: TrustedTypePolicyFactory } = globalThis;
  page.trustedTypes?.createPolicy("default", {
    createScriptURL: (input) => {
      const url = new URL(input, location.href);
      if (url.origin !== location.origin || !KERNEL_WORKER.test(url.pathname)) {
        throw new TypeError(`script URL not allowed: ${input}`);
      }
      return url.href;
    },
  });
}
