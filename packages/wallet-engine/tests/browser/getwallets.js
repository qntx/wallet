// ../../node_modules/.bun/@wallet-standard+app@1.1.1/node_modules/@wallet-standard/app/lib/esm/wallets.js
var __classPrivateFieldGet = function(receiver, state, kind, f) {
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet = function(receiver, state, value, kind, f) {
  if (kind === "m")
    throw new TypeError("Private method is not writable");
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var _AppReadyEvent_detail;
var wallets = undefined;
var registeredWalletsSet = new Set;
function addRegisteredWallet(wallet) {
  cachedWalletsArray = undefined;
  registeredWalletsSet.add(wallet);
}
function removeRegisteredWallet(wallet) {
  cachedWalletsArray = undefined;
  registeredWalletsSet.delete(wallet);
}
var listeners = {};
function getWallets() {
  if (wallets)
    return wallets;
  wallets = Object.freeze({ register, get, on });
  if (typeof window === "undefined")
    return wallets;
  const api = Object.freeze({ register });
  try {
    window.addEventListener("wallet-standard:register-wallet", ({ detail: callback }) => callback(api));
  } catch (error) {
    console.error(`wallet-standard:register-wallet event listener could not be added
`, error);
  }
  try {
    window.dispatchEvent(new AppReadyEvent(api));
  } catch (error) {
    console.error(`wallet-standard:app-ready event could not be dispatched
`, error);
  }
  return wallets;
}
function register(...wallets) {
  wallets = wallets.filter((wallet) => !registeredWalletsSet.has(wallet));
  if (!wallets.length)
    return () => {};
  wallets.forEach((wallet) => addRegisteredWallet(wallet));
  listeners["register"]?.forEach((listener) => guard(() => listener(...wallets)));
  return function unregister() {
    wallets.forEach((wallet) => removeRegisteredWallet(wallet));
    listeners["unregister"]?.forEach((listener) => guard(() => listener(...wallets)));
  };
}
var cachedWalletsArray;
function get() {
  if (!cachedWalletsArray) {
    cachedWalletsArray = [...registeredWalletsSet];
  }
  return cachedWalletsArray;
}
function on(event, listener) {
  listeners[event]?.push(listener) || (listeners[event] = [listener]);
  return function off() {
    listeners[event] = listeners[event]?.filter((existingListener) => listener !== existingListener);
  };
}
function guard(callback) {
  try {
    callback();
  } catch (error) {
    console.error(error);
  }
}

class AppReadyEvent extends Event {
  get detail() {
    return __classPrivateFieldGet(this, _AppReadyEvent_detail, "f");
  }
  get type() {
    return "wallet-standard:app-ready";
  }
  constructor(api) {
    super("wallet-standard:app-ready", {
      bubbles: false,
      cancelable: false,
      composed: false
    });
    _AppReadyEvent_detail.set(this, undefined);
    __classPrivateFieldSet(this, _AppReadyEvent_detail, api, "f");
  }
  preventDefault() {
    throw new Error("preventDefault cannot be called");
  }
  stopImmediatePropagation() {
    throw new Error("stopImmediatePropagation cannot be called");
  }
  stopPropagation() {
    throw new Error("stopPropagation cannot be called");
  }
}
_AppReadyEvent_detail = new WeakMap;

// tests/browser/getwallets-entry.ts
var wallets2 = getWallets();
globalThis["__getWallets"] = () => wallets2;
