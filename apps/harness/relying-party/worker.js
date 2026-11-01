// Relying-party association files for the harness's native passkey tests (W6):
// wallet-harness.qntx.org is the harness's WebAuthn rpId. iOS reads the
// webcredentials app list, Android Credential Manager reads the asset links
// (Google's Digital Asset Links service fetches it, so it must be public).
// The Android fingerprint is the harness's release signing key — the shared
// React Native debug keystore, test builds only.
const AASA = {
  webcredentials: { apps: ["6Z33CD4837.org.qntx.wallet.harness"] },
};

const ASSET_LINKS = [
  {
    relation: [
      "delegate_permission/common.handle_all_urls",
      "delegate_permission/common.get_login_creds",
    ],
    target: {
      namespace: "android_app",
      package_name: "org.qntx.wallet.harness",
      sha256_cert_fingerprints: [
        "FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C",
      ],
    },
  },
];

const FILES = {
  "/.well-known/apple-app-site-association": AASA,
  "/.well-known/assetlinks.json": ASSET_LINKS,
};

export default {
  fetch(request) {
    const body = FILES[new URL(request.url).pathname];
    if (request.method !== "GET" || body === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json", "cache-control": "max-age=300" },
    });
  },
};
