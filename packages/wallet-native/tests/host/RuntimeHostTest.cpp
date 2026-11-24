// Host test driver for the kernel runtime. One binary, one case per process:
// argv[1] selects the case, argv[2] optionally names a .hbc file for the
// bytecode variants. KDF reference values arrive via env vars
// V1_PBKDF2_SHA256_1 / V1_PBKDF2_SHA256_80000 / V1_PBKDF2_SHA512_UTF8 and
// V1_ARGON2ID_BACKUP / V1_ARGON2ID_SMALL.
#include "runtime/KernelRuntime.hpp"
#include "host/CardReader.hpp"
#include "host/KernelFile.hpp"
#include "host/KernelSlot.hpp"
#include "host/VaultAnchor.hpp"
#include "host/Lifecycle.hpp"
#include "host/SecureInput.hpp"
#include "HostCardReader.hpp"
#include "HostKeystore.hpp"
#include "HostPasskey.hpp"
#include "HostNostrNative.hpp"
#include "HostVaultAnchor.hpp"
#include "HostQntxSpark.hpp"
#include "kernel.hpp"

#if __has_include("generated/probes.hpp")
#include "generated/probes.hpp"
#else
#error "generated/probes.hpp missing — run `bun run harness:bundles` first"
#endif

#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>
#include <cstdlib>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>
#include <cstring>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <vector>

#if defined(__APPLE__)
#include <mach/mach.h>
#endif

namespace {

namespace jsi = facebook::jsi;
using qntx::KernelProfile;
using qntx::KernelRuntime;
using qntx::KernelScript;
using Clock = std::chrono::steady_clock;

// destroy() only requests the stop and the kernel thread is detached, so every case waits for
// it before returning: its hooks reference the case's stack.
int g_failures = 0;

#define CHECK(cond, msg)                                                       \
  do {                                                                         \
    if (!(cond)) {                                                             \
      ++g_failures;                                                            \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, msg);       \
    }                                                                          \
  } while (0)

struct Mailbox {
  std::mutex m;
  std::condition_variable cv;
  std::vector<std::string> posts;
  std::vector<std::string> errors;

  void post(qntx::SecretBytes bytes) {
    {
      std::lock_guard<std::mutex> lock(m);
      posts.emplace_back(bytes.data(), bytes.data() + bytes.size());
    }
    cv.notify_all();
  }
  void fail(std::string message) {
    {
      std::lock_guard<std::mutex> lock(m);
      errors.push_back(std::move(message));
    }
    cv.notify_all();
  }
  // Waits for at least `n` posts. More can land before the caller wakes —
  // compare against expectations with posts.size(), not this return.
  bool waitPosts(size_t n, std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(m);
    return cv.wait_for(lock, timeout, [&] { return posts.size() >= n; });
  }
  bool waitErrors(size_t n, std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(m);
    cv.wait_for(lock, timeout, [&] { return errors.size() >= n; });
    return errors.size() >= n;
  }
  void dump() const {
    for (const auto& post : posts) {
      std::fprintf(stderr, "  post: %s\n", post.c_str());
    }
    for (const auto& error : errors) {
      std::fprintf(stderr, "  error: %s\n", error.c_str());
    }
  }
};

// Frame bytes must cross the runtime boundary in wipe-on-release storage:
// onPost hands the hook a SecretBytes that zeroes itself when dropped, and
// post() takes the same so every queue/teardown path wipes.
static_assert(
    std::is_same_v<
        decltype(KernelRuntime::Hooks::onPost),
        std::function<void(qntx::SecretBytes)>>,
    "onPost must deliver frames in SecretBytes");
static_assert(
    std::is_same_v<decltype(&KernelRuntime::post), void (KernelRuntime::*)(qntx::SecretBytes)>,
    "post must take frames in SecretBytes");

KernelRuntime::Hooks hooksFor(Mailbox& box) {
  KernelRuntime::Hooks hooks;
  hooks.onPost = [&box](qntx::SecretBytes bytes) { box.post(std::move(bytes)); };
  hooks.onError = [&box](std::string message) { box.fail(std::move(message)); };
  return hooks;
}

KernelScript sourceScript(const std::string& source) {
  return {
      KernelScript::Kind::source,
      std::make_shared<const std::vector<uint8_t>>(source.begin(), source.end())};
}

KernelScript bytecodeScript(const std::vector<uint8_t>& bytes) {
  return {
      KernelScript::Kind::bytecode,
      std::make_shared<const std::vector<uint8_t>>(bytes)};
}

KernelScript probeScript(const qntx::harness::probes::Script& probe, bool bytecode) {
  return {
      bytecode ? KernelScript::Kind::bytecode : KernelScript::Kind::source,
      bytecode
          ? std::make_shared<const std::vector<uint8_t>>(
                probe.bytecode, probe.bytecode + probe.bytecodeSize)
          : std::make_shared<const std::vector<uint8_t>>(
                probe.source, probe.source + probe.sourceSize)};
}

std::vector<uint8_t> readFile(const char* path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    return {};
  }
  return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}

// The kernel post channel carries ASCII JSON/text; this helper emits it from JS.
const char kSendHelper[] = R"JS(
function __send(s) {
  var b = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) {
    b[i] = s.charCodeAt(i) & 0xff;
  }
  __qntx.frames.post(b.buffer);
}
)JS";

uint64_t physicalFootprint() {
#if defined(__APPLE__)
  task_vm_info_data_t info{};
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  if (task_info(
          mach_task_self(), TASK_VM_INFO,
          reinterpret_cast<task_info_t>(&info), &count) != KERN_SUCCESS) {
    return 0;
  }
  return info.phys_footprint;
#else
  return 0;
#endif
}

// Mirrors KernelRuntime's internal config so the inventory test can diff
// against a bare runtime of the same profile.
::hermes::vm::RuntimeConfig bareConfig(KernelProfile profile) {
  auto builder = profile == KernelProfile::hardened
      ? facebook::hermes::hardenedHermesRuntimeConfig().rebuild()
      : ::hermes::vm::RuntimeConfig::Builder();
  return builder.withMicrotaskQueue(true)
      .withEnableEval(false)
      .withAsyncBreakCheckInEval(true)
      .withES6BlockScoping(true)
      .build();
}

std::set<std::string> globalNames(jsi::Runtime& rt) {
  auto result = rt.evaluateJavaScript(
      std::make_shared<jsi::StringBuffer>(
          "JSON.stringify(Object.getOwnPropertyNames(globalThis))"),
      "<names>");
  const std::string json = result.asString(rt).utf8(rt);
  std::set<std::string> names;
  size_t i = 0;
  while (i < json.size()) {
    auto begin = json.find('"', i);
    if (begin == std::string::npos) {
      break;
    }
    auto end = json.find('"', begin + 1);
    if (end == std::string::npos) {
      break;
    }
    names.insert(json.substr(begin + 1, end - begin - 1));
    i = end + 1;
  }
  return names;
}

int destroyBusyloop(const char* hbcPath) {
  const bool bytecode = hbcPath != nullptr;
  const std::string js = std::string(kSendHelper) +
      "__send(\"ready\"); var t = Date.now(); while (Date.now() - t < 3000) {}";
  Mailbox box;
  auto rt = KernelRuntime::start(
      bytecode ? bytecodeScript(readFile(hbcPath)) : sourceScript(js),
      hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(15)), "busyloop: ready post missing");
  const auto t0 = Clock::now();
  rt->destroy();
  const auto destroyMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();
  CHECK(destroyMs < 50, "busyloop: destroy() blocked >= 50ms");
  CHECK(
      rt->waitUntilStopped(std::chrono::seconds(1)),
      "busyloop: runtime did not stop within 1s");
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  CHECK(box.errors.empty(), "busyloop: destroy surfaced onError");
  return g_failures;
}

// destroy() can win the race against script evaluation itself: whichever side
// is faster, the runtime must stop without the script ever running its loop
// body to completion — and without surfacing an error.
int destroyBeforeEvaluate() {
  Mailbox box;
  auto rt = KernelRuntime::start(
      sourceScript(std::string(kSendHelper) +
          "var t = Date.now(); while (Date.now() - t < 3000) {} __send(\"done\");"),
      hooksFor(box), "");
  const auto t0 = Clock::now();
  rt->destroy();
  const auto destroyMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count();
  CHECK(destroyMs < 50, "destroy-before-evaluate: destroy() blocked >= 50ms");
  CHECK(
      rt->waitUntilStopped(std::chrono::seconds(1)),
      "destroy-before-evaluate: runtime did not stop within 1s");
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  {
    std::lock_guard<std::mutex> lock(box.m);
    CHECK(box.posts.empty(), "destroy-before-evaluate: script post arrived");
    CHECK(box.errors.empty(), "destroy-before-evaluate: unexpected onError");
  }
  return g_failures;
}

// A runtime destroyed while its beforeEvaluate hook still waits (a successor
// waiting out a stopping predecessor) never evaluates the kernel once the
// hook returns: it stops instead.
int destroyDuringBeforeEvaluate() {
  Mailbox box;
  std::mutex gateMutex;
  std::condition_variable gateCv;
  bool entered = false;
  bool open = false;
  auto hooks = hooksFor(box);
  hooks.beforeEvaluate = [&](jsi::Runtime&) {
    std::unique_lock<std::mutex> lock(gateMutex);
    entered = true;
    gateCv.notify_all();
    gateCv.wait(lock, [&] { return open; });
  };
  auto rt = KernelRuntime::start(
      sourceScript(std::string(kSendHelper) + "__send(\"evaluated\");"), hooks, "");
  {
    std::unique_lock<std::mutex> lock(gateMutex);
    CHECK(
        gateCv.wait_for(lock, std::chrono::seconds(15), [&] { return entered; }),
        "destroy-during-before-evaluate: hook never ran");
  }
  rt->destroy();
  {
    std::lock_guard<std::mutex> lock(gateMutex);
    open = true;
  }
  gateCv.notify_all();
  CHECK(
      rt->waitUntilStopped(std::chrono::seconds(5)),
      "destroy-during-before-evaluate: runtime did not stop");
  {
    std::lock_guard<std::mutex> lock(box.m);
    CHECK(box.posts.empty(), "destroy-during-before-evaluate: the kernel evaluated after destroy");
    CHECK(box.errors.empty(), "destroy-during-before-evaluate: unexpected onError");
  }
  return g_failures;
}

int destroyConcurrent() {
  Mailbox box;
  auto rt = KernelRuntime::start(
      sourceScript(std::string(kSendHelper) + "__send(\"ready\");"), hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(15)), "concurrent: ready post missing");
  std::thread a([&] {
    for (int i = 0; i < 10; i++) {
      rt->destroy();
    }
  });
  std::thread b([&] {
    for (int i = 0; i < 10; i++) {
      rt->destroy();
    }
  });
  a.join();
  b.join();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "concurrent: runtime still running");
  CHECK(box.errors.empty(), "concurrent: unexpected onError");
  return g_failures;
}

int destroyKdfInflight() {
  Mailbox box;
  auto rt = KernelRuntime::start(
      sourceScript(
          std::string(kSendHelper) +
          "__qntx.pbkdf2(\"sha256\", new Uint8Array(16), new Uint8Array(16), 10000000, 32,"
          " function () { __send(\"kdf-done\"); });"
          "__send(\"submitted\");"),
      hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(15)), "kdf-inflight: submit post missing");
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "kdf-inflight: runtime still running");
  std::this_thread::sleep_for(std::chrono::milliseconds(500));
  CHECK(box.posts.size() == 1, "kdf-inflight: completion callback fired after destroy");
  CHECK(box.errors.empty(), "kdf-inflight: unexpected onError");
  return g_failures;
}

int timersCancel() {
  const uint64_t before = physicalFootprint();
  Mailbox box;
  auto rt = KernelRuntime::start(
      sourceScript(
          std::string(kSendHelper) +
          "for (var i = 0; i < 200000; i++) {"
          "  var cancel = __qntx.setTimer(3600000, function () {});"
          "  cancel();"
          "}"
          "__send(\"done\");"),
      hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(120)), "timers-cancel: never finished");
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  const uint64_t after = physicalFootprint();
  std::fprintf(stderr, "timers-cancel footprint: %llu -> %llu\n",
      (unsigned long long)before, (unsigned long long)after);
  CHECK(after - before < 20ULL * 1024 * 1024, "timers-cancel: footprint grew >= 20MB");
  return g_failures;
}

int timersFired() {
  const uint64_t before = physicalFootprint();
  Mailbox box;
  auto rt = KernelRuntime::start(
      sourceScript(
          std::string(kSendHelper) +
          "var i = 0;"
          "function next() {"
          "  i += 1;"
          "  if (i >= 100000) { __send(\"done\"); } else { __qntx.setTimer(0, next); }"
          "}"
          "__qntx.setTimer(0, next);"),
      hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(120)), "timers-fired: never finished");
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  const uint64_t after = physicalFootprint();
  std::fprintf(stderr, "timers-fired footprint: %llu -> %llu\n",
      (unsigned long long)before, (unsigned long long)after);
  CHECK(after - before < 20ULL * 1024 * 1024, "timers-fired: footprint grew >= 20MB");
  return g_failures;
}

int forgedViews() {
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
function tryCall(f) {
  try {
    f();
    return "no-throw";
  } catch (e) {
    return "threw";
  }
}
var forged = { buffer: new ArrayBuffer(16), byteOffset: 1048576, byteLength: 64 };
__send("pbkdf2-forged:" + tryCall(function () {
  __qntx.pbkdf2("sha256", forged, new Uint8Array(16), 1, 32, function () {});
}));
__send("grv-forged:" + tryCall(function () {
  crypto.getRandomValues(forged);
}));
Object.defineProperty(Uint8Array.prototype, "byteOffset", {
  get: function () { return 1048576; },
  configurable: true,
});
// The intrinsic getters must keep reporting the real slots: a genuine view
// still works and is filled at its true offset even though JS now reads a lie.
__send("grv-redefined:" + tryCall(function () {
  var v = new Uint8Array(16);
  crypto.getRandomValues(v);
}));
__send("pbkdf2-redefined:" + tryCall(function () {
  __qntx.pbkdf2("sha256", new Uint8Array(4), new Uint8Array(4), 1, 32,
      function (r) { __send("pbkdf2-done:" + (r ? r.length : "none")); });
}));
)JS";
  auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
  CHECK(box.waitPosts(5, std::chrono::seconds(30)), "forged: missing posts");
  std::lock_guard<std::mutex> lock(box.m);
  CHECK(box.posts.size() >= 4 && box.posts[0] == "pbkdf2-forged:threw",
      "forged: pbkdf2 accepted forged view");
  CHECK(box.posts.size() >= 4 && box.posts[1] == "grv-forged:threw",
      "forged: getRandomValues accepted forged view");
  CHECK(box.posts.size() >= 4 && box.posts[2] == "grv-redefined:no-throw",
      "forged: getRandomValues failed on a genuine view after getter redefinition");
  CHECK(box.posts.size() >= 4 && box.posts[3] == "pbkdf2-redefined:no-throw",
      "forged: pbkdf2 rejected a genuine view after getter redefinition");
  CHECK(box.posts.size() >= 5 && box.posts[4] == "pbkdf2-done:32",
      "forged: pbkdf2 completion never arrived");
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  return g_failures;
}

int numericValidation() {
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
var bad = [NaN, Infinity, -1, 1e300, 1.5];
var out = [];
function t(name, f) {
  try {
    var r = f();
    if (typeof r === "function") { r(); }
    out.push(name + ":ok");
  } catch (e) {
    out.push(name + ":threw");
  }
}
for (var i = 0; i < bad.length; i++) {
  var v = bad[i];
  (function (v) {
    t("random-" + v, function () { __qntx.random(v); });
    t("timer-" + v, function () { return __qntx.setTimer(v, function () {}); });
    t("kdf-it-" + v, function () {
      __qntx.pbkdf2("sha256", new Uint8Array(4), new Uint8Array(4), v, 32, function () {});
    });
    t("kdf-len-" + v, function () {
      __qntx.pbkdf2("sha256", new Uint8Array(4), new Uint8Array(4), 1, v, function () {});
    });
  })(v);
}
__send(out.join(","));
)JS";
  auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(30)), "numeric: no report");
  std::string report;
  {
    std::lock_guard<std::mutex> lock(box.m);
    if (!box.posts.empty()) {
      report = box.posts[0];
    }
  }
  // These are the JS String() renderings the report uses — 1e300 prints "1e+300".
  const std::vector<std::string> bad = {"NaN", "Infinity", "-1", "1e+300", "1.5"};
  for (const auto& value : bad) {
    const bool fractionalDelay = value == "1.5";
    CHECK(report.find("random-" + value + ":threw") != std::string::npos,
        ("numeric: random accepted " + value).c_str());
    const std::string timer = "timer-" + value;
    if (fractionalDelay) {
      CHECK(report.find(timer + ":ok") != std::string::npos,
          "numeric: setTimer rejected fractional delay");
    } else {
      CHECK(report.find(timer + ":threw") != std::string::npos,
          ("numeric: setTimer accepted " + value).c_str());
    }
    CHECK(report.find("kdf-it-" + value + ":threw") != std::string::npos,
        ("numeric: pbkdf2 accepted iterations " + value).c_str());
    CHECK(report.find("kdf-len-" + value + ":threw") != std::string::npos,
        ("numeric: pbkdf2 accepted length " + value).c_str());
  }
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  return g_failures;
}

int randomBounds() {
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
var out = [];
function t(name, f) {
  try { out.push(name + ":" + f()); } catch (e) { out.push(name + ":threw"); }
}
t("r0", function () { return __qntx.random(0).length; });
t("r32", function () { return __qntx.random(32).length; });
t("r65536", function () { return __qntx.random(65536).length; });
t("r65537", function () { __qntx.random(65537); });
var a = __qntx.random(32);
var b = __qntx.random(32);
var same = a.length === b.length;
for (var i = 0; same && i < a.length; i++) { same = a[i] === b[i]; }
out.push("distinct:" + (same ? "no" : "yes"));
__send(out.join(","));
)JS";
  auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(30)), "random: no report");
  std::lock_guard<std::mutex> lock(box.m);
  CHECK(!box.posts.empty() &&
            box.posts[0].find("r0:0") != std::string::npos &&
            box.posts[0].find("r32:32") != std::string::npos &&
            box.posts[0].find("r65536:65536") != std::string::npos &&
            box.posts[0].find("r65537:threw") != std::string::npos &&
            box.posts[0].find("distinct:yes") != std::string::npos,
      "random: unexpected bounds report");
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  return g_failures;
}

int getRandomValuesCase() {
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
var out = [];
function t(name, f) {
  try { out.push(name + ":" + f()); } catch (e) { out.push(name + ":threw"); }
}
var a = new Uint8Array(16);
a.fill(0xaa);
var sub = a.subarray(4, 8);
var ret = crypto.getRandomValues(sub);
var windowOnly = ret === sub;
for (var i = 0; windowOnly && i < 16; i++) {
  if ((i < 4 || i >= 8) && a[i] !== 0xaa) { windowOnly = false; }
}
out.push("subarray:" + (windowOnly ? "yes" : "no"));
t("float64", function () { crypto.getRandomValues(new Float64Array(4)); });
t("big65k", function () { crypto.getRandomValues(new Uint8Array(65537)); });
t("bigint64", function () { return crypto.getRandomValues(new BigInt64Array(4)).length; });
t("plain", function () { crypto.getRandomValues({ length: 4 }); });
__send(out.join(","));
)JS";
  auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(30)), "grv: no report");
  std::lock_guard<std::mutex> lock(box.m);
  CHECK(!box.posts.empty() &&
            box.posts[0].find("subarray:yes") != std::string::npos &&
            box.posts[0].find("float64:threw") != std::string::npos &&
            box.posts[0].find("big65k:threw") != std::string::npos &&
            box.posts[0].find("bigint64:4") != std::string::npos &&
            box.posts[0].find("plain:threw") != std::string::npos,
      "grv: unexpected report");
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  return g_failures;
}

int crashCase(bool promise, bool bytecode) {
  Mailbox box;
  const auto& script =
      promise ? qntx::harness::probes::kCrashPromise : qntx::harness::probes::kCrashSync;
  auto rt = KernelRuntime::start(probeScript(script, bytecode), hooksFor(box), "");
  CHECK(box.waitErrors(1, std::chrono::seconds(30)), "crash: no onError");
  CHECK(
      rt->waitUntilStopped(std::chrono::seconds(1)),
      "crash: runtime not stopped within 1s without destroy");
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
  CHECK(box.errors.size() == 1, "crash: expected exactly one onError");
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  return g_failures;
}

int evalDisabled(KernelProfile profile) {
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
var out = [];
try { eval("1"); out.push("eval:ran"); } catch (e) { out.push("eval:threw"); }
try { Function("return 1")(); out.push("fn:ran"); } catch (e) { out.push("fn:threw"); }
__send(out.join(","));
)JS";
  auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "", profile);
  CHECK(box.waitPosts(1, std::chrono::seconds(30)), "eval: no report");
  std::lock_guard<std::mutex> lock(box.m);
  CHECK(!box.posts.empty() &&
            box.posts[0].find("eval:threw") != std::string::npos &&
            box.posts[0].find("fn:threw") != std::string::npos,
      "eval: eval or Function ran");
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  return g_failures;
}

int globalDescriptors() {
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
function hidden(name) {
  var d = Object.getOwnPropertyDescriptor(globalThis, name);
  return d && d.writable === false && d.configurable === false && d.enumerable === false;
}
function stillThere(name, kind) {
  try { globalThis[name] = 1; } catch (e) {}
  try { delete globalThis[name]; } catch (e) {}
  return typeof globalThis[name] === kind;
}
function decoderTamper() {
  try { TextDecoder.prototype.decode = function () { return "forged"; }; } catch (e) {}
  var bytes = new Uint8Array([0x68, 0x69]);
  var stillWorks = new TextDecoder().decode(bytes) === "hi";
  var threw = false;
  try {
    Object.defineProperty(TextDecoder.prototype, "decode", { value: function () { return "x"; } });
  } catch (e) { threw = true; }
  return stillWorks && threw;
}
__send(JSON.stringify({
  qntx: hidden("__qntx") && Object.isFrozen(__qntx) && stillThere("__qntx", "object"),
  crypto: hidden("crypto") && Object.isFrozen(crypto) && stillThere("crypto", "object"),
  decoder: hidden("TextDecoder") && stillThere("TextDecoder", "function") && decoderTamper(),
  noPrivate: Object.getOwnPropertyNames(globalThis).indexOf("__qntxUnhandledRejection") < 0,
}));
)JS";
  auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(30)), "descriptors: no report");
  std::lock_guard<std::mutex> lock(box.m);
  CHECK(!box.posts.empty() &&
            box.posts[0].find("\"qntx\":true") != std::string::npos &&
            box.posts[0].find("\"crypto\":true") != std::string::npos &&
            box.posts[0].find("\"decoder\":true") != std::string::npos &&
            box.posts[0].find("\"noPrivate\":true") != std::string::npos,
      "descriptors: globals writable/configurable/enumerable or deletable");
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  return g_failures;
}

// ── W2b/W3: file primitive, queue cap, kernel bytecode, __qntx inventory ────

// ── W7: background-lock lifecycle ──────────────────────────────────────────

int lifecycleBoundaries() {
  // backgroundExpired(bgAt, now, seconds): expired once now >= bgAt + seconds.
  CHECK(!qntx::backgroundExpired(1000, 1000 + 59999, 60),
      "lifecycle: just before expiry must not lock");
  CHECK(qntx::backgroundExpired(1000, 1000 + 60000, 60),
      "lifecycle: exactly at the deadline must lock");
  CHECK(qntx::backgroundExpired(1000, 1000 + 60001, 60),
      "lifecycle: just past the deadline must lock");
  CHECK(!qntx::backgroundExpired(0, 899999, 900),
      "lifecycle: just before a 900s deadline must not lock");
  CHECK(qntx::backgroundExpired(0, 900000, 900),
      "lifecycle: 900s deadline edge");
  return g_failures;
}

namespace {

class FakeLockTarget : public qntx::LifecycleLockTarget {
 public:
  int locks = 0;
  void lockForBackground() override { locks++; }
};

} // namespace

int lifecycleDispatcher() {
  auto& dispatcher = qntx::KernelLifecycleDispatcher::shared();
  int64_t now = 100000;
  dispatcher.setClock([&now] { return now; });

  const auto zero = std::make_shared<FakeLockTarget>();
  const auto sixty = std::make_shared<FakeLockTarget>();
  const auto nine = std::make_shared<FakeLockTarget>();
  dispatcher.registerHost(zero, 0);
  dispatcher.registerHost(sixty, 60);
  dispatcher.registerHost(nine, 900);

  // A fresh registration has no background stamp: a foreground event (e.g. the
  // observer replay at install on Android) must not lock anything.
  dispatcher.onForeground();
  CHECK(zero->locks == 0 && sixty->locks == 0 && nine->locks == 0,
      "lifecycle: a never-backgrounded host locked on foreground");

  // seconds==0 locks the moment the app backgrounds; the others stamp.
  dispatcher.onBackground();
  CHECK(zero->locks == 1, "lifecycle: seconds==0 did not lock on background");
  CHECK(sixty->locks == 0 && nine->locks == 0,
      "lifecycle: nonzero hosts locked too early");

  // Foreground before the deadline: nobody else locks.
  now += 59000;
  dispatcher.onForeground();
  CHECK(sixty->locks == 0, "lifecycle: 60s host locked before its deadline");

  // Background again, sit past 60s: only the 60s host expires.
  dispatcher.onBackground();
  now += 61000;
  dispatcher.onForeground();
  CHECK(sixty->locks == 1, "lifecycle: 60s host did not lock on expiry");
  CHECK(nine->locks == 0, "lifecycle: 900s host locked too early");

  // An expired weak_ptr and an unregistered host are skipped.
  {
    const auto gone = std::make_shared<FakeLockTarget>();
    dispatcher.registerHost(gone, 60);
    dispatcher.unregister(gone.get());
  }
  dispatcher.onBackground();
  now += 61000;
  dispatcher.onForeground();
  CHECK(g_failures == 0, "lifecycle: stale registrations fired");

  // update keeps the recorded background stamp: shortening a running budget
  // past its already-elapsed time locks on the next foreground.
  {
    const auto upd = std::make_shared<FakeLockTarget>();
    const auto stranger = std::make_shared<FakeLockTarget>();
    dispatcher.registerHost(upd, 900);
    dispatcher.onBackground();
    now += 70000;
    dispatcher.update(upd.get(), 60);
    dispatcher.update(stranger.get(), 0); // an unregistered host: a no-op
    dispatcher.onForeground();
    CHECK(upd->locks == 1, "lifecycle: a shortened running budget did not expire");
    CHECK(stranger->locks == 0, "lifecycle: update on an unregistered host fired");
    dispatcher.unregister(upd.get());
  }

  dispatcher.unregister(zero.get());
  dispatcher.unregister(sixty.get());
  dispatcher.unregister(nine.get());
  dispatcher.setClock(qntx::sleepInclusiveMonotonicMs);
  return g_failures;
}

// The shipped compile-kernel.mjs produces this header during the host-test
// build — running its KERNEL_BYTECODE end-to-end proves the shipped artifact.
int kernelBytecode() {
  Mailbox box;
  const auto script = bytecodeScript(
      {qntx::KERNEL_BYTECODE, qntx::KERNEL_BYTECODE + qntx::KERNEL_BYTECODE_SIZE});
  auto rt = KernelRuntime::start(script, hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(180)),
      "kernel-bytecode: expected the kernel's first frame");
  {
    std::lock_guard<std::mutex> lock(box.m);
    // The kernel speaks CBOR; its first frame is the status event, whose
    // "event"/"status" keys appear verbatim inside the frame bytes.
    CHECK(!box.posts.empty() && box.posts[0].find("status") != std::string::npos,
        "kernel-bytecode: first post was not the kernel's status frame");
  }
  CHECK(box.errors.empty(), "kernel-bytecode: unexpected onError");
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  return g_failures;
}

// The injected __qntx surface is the kernel's entire contract with the host —
// the name set must match enclave.mdx exactly and every object member must be
// frozen so kernel code cannot rewire its primitives.
int qntxGlobals() {
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
var names = Object.getOwnPropertyNames(__qntx).sort();
var frozen = Object.isFrozen(__qntx);
var objectsFrozen = names.every(function (n) {
  var member = __qntx[n];
  return typeof member !== "object" || member === null || Object.isFrozen(member);
});
var spark = __qntx.backends.spark;
var nostr = __qntx.backends.nostr;
__send(names.join(",") + "|frozen=" + frozen + "|objectsFrozen=" + objectsFrozen +
  "|sparkFrozen=" + Object.isFrozen(spark) + "|sparkAbi=" + typeof spark.abiVersion +
  "|nostrFrozen=" + Object.isFrozen(nostr) + "|nostrAbi=" + typeof nostr.abiVersion);
)JS";
  {
    auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
    CHECK(box.waitPosts(1, std::chrono::seconds(30)), "qntx-globals: no report");
    rt->destroy();
    CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  }
  std::lock_guard<std::mutex> lock(box.m);
  CHECK(box.posts.size() == 1 &&
            box.posts[0] ==
                "anchor,argon2id,backends,cardReader,elapsed,file,frames,keystore,now,passkey,pbkdf2,random,secureInput,setTimer"
                "|frozen=true|objectsFrozen=true|sparkFrozen=true|sparkAbi=number"
                "|nostrFrozen=true|nostrAbi=number",
      "qntx-globals: __qntx inventory or freeze state drifted — reconcile enclave.mdx");
  return g_failures;
}

// The keystore bridge: arguments are validated before the platform sees them,
// prompts and bytes reach the platform verbatim, completions come back on the
// kernel thread with the KEK as a Uint8Array, and every failure status maps to
// its kernel error code.
int keystoreBinding() {
  qntxTestKeystore::reset();
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
var ks = __qntx.keystore;
var r = ["locale=" + ks.locale, "platform=" + ks.platform, "frozen=" + Object.isFrozen(ks)];
r.push("names=" + Object.getOwnPropertyNames(ks).sort().join(","));
var id = "0123456789abcdef0123456789abcdef";
var kek = new Uint8Array(32);
for (var i = 0; i < 32; i++) kek[i] = i;
function throws(name, fn) {
  try { fn(); r.push(name + "=nothrow"); } catch (e) { r.push(name + "=ok"); }
}
var done = function () {};
throws("badId", function () { ks.seal("ABC", kek, "t", "d", done); });
throws("shortSecret", function () { ks.seal(id, new Uint8Array(31), "t", "d", done); });
throws("emptyTitle", function () { ks.open(id, new Uint8Array(4), "", "d", done); });
throws("longDescription", function () { ks.open(id, new Uint8Array(4), "t", new Array(1026).join("x"), done); });
throws("emptySealed", function () { ks.open(id, new Uint8Array(0), "t", "d", done); });
throws("noCallback", function () { ks.clear(1); });
throws("deviceBadId", function () { ks.sealDevice("xyz", kek, done); });
throws("deviceShortSecret", function () { ks.sealDevice(id, new Uint8Array(8), done); });
throws("deviceEmptySealed", function () { ks.openDevice(id, new Uint8Array(0), done); });
throws("badProtection", function () { ks.probe(id, "presence-ish", done); });
throws("removeNoCallback", function () { ks.remove(id); });
function step(fn) { return new Promise(function (resolve) { fn(function (value, code, detail) { resolve([value, code, detail]); }); }); }
step(function (cb) { ks.seal(id, kek, "保护钱包", "验证身份", cb); }).then(function (sealed) {
  r.push("sealed=" + (sealed[0] instanceof Uint8Array && sealed[0].length === 32 && sealed[1] === undefined));
  return step(function (cb) { ks.open(id, sealed[0], "解锁钱包", "验证身份以解锁钱包", cb); });
}).then(function (opened) {
  var same = opened[0] instanceof Uint8Array && opened[0].length === 32;
  for (var j = 0; same && j < 32; j++) same = opened[0][j] === j;
  r.push("opened=" + same);
  return step(function (cb) { ks.sealDevice(id, kek, cb); });
}).then(function (dsealed) {
  r.push("dsealed=" + (dsealed[0] instanceof Uint8Array && dsealed[0].length === 32));
  return step(function (cb) { ks.openDevice(id, dsealed[0], cb); });
}).then(function (dopened) {
  var dsame = dopened[0] instanceof Uint8Array && dopened[0].length === 32;
  for (var k = 0; dsame && k < 32; k++) dsame = dopened[0][k] === k;
  r.push("dopened=" + dsame);
  return step(function (cb) { ks.probe(id, "device", cb); });
}).then(function (pd) {
  r.push("probeDevice=" + (pd[0] === undefined && pd[1] === undefined));
  return step(function (cb) { ks.probe(id, "presence", cb); });
}).then(function (pp) {
  r.push("probePresence=" + (pp[0] === undefined && pp[1] === undefined));
  return step(function (cb) { ks.remove(id, cb); });
}).then(function (rm) {
  r.push("removed=" + (rm[0] === undefined && rm[1] === undefined));
  return step(function (cb) { ks.probe(id, "device", cb); });
}).then(function (gone) {
  r.push("probeGone=" + gone[1]);
  return step(function (cb) { ks.authenticate("重置钱包", "验证设备所有者", cb); });
}).then(function (auth) {
  r.push("auth=" + (auth[0] === undefined && auth[1] === undefined));
  return step(function (cb) { ks.open("ffffffffffffffffffffffffffffffff", new Uint8Array(4), "t", "d", cb); });
}).then(function (missing) {
  r.push("missing=" + missing[1]);
  return step(function (cb) { ks.authenticate("fail:cancelled", "d", cb); });
}).then(function (c1) {
  r.push("cancelled=" + c1[1]);
  return step(function (cb) { ks.authenticate("fail:unavailable", "d", cb); });
}).then(function (c2) {
  r.push("unavailable=" + c2[1] + "/" + c2[2]);
  return step(function (cb) { ks.authenticate("fail:nolockscreen", "d", cb); });
}).then(function (c2b) {
  r.push("nolockscreen=" + c2b[1] + "/" + c2b[2]);
  return step(function (cb) { ks.open(id, new Uint8Array(4), "fail:failed", "d", cb); });
}).then(function (c3) {
  r.push("failed=" + c3[1]);
  return step(function (cb) { ks.clear(cb); });
}).then(function (c4) {
  r.push("clear=" + (c4[0] === undefined && c4[1] === undefined));
  __send(r.join(" "));
});
)JS";
  {
    auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
    CHECK(box.waitPosts(1, std::chrono::seconds(30)), "keystore-binding: no report");
    rt->destroy();
    CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  }
  std::lock_guard<std::mutex> lock(box.m);
  CHECK(box.posts.size() == 1 &&
            box.posts[0] ==
                "locale=zh-Hans-CN platform=ios frozen=true "
                "names=authenticate,clear,locale,open,openDevice,platform,probe,remove,seal,sealDevice "
                "badId=ok shortSecret=ok emptyTitle=ok longDescription=ok emptySealed=ok "
                "noCallback=ok deviceBadId=ok deviceShortSecret=ok deviceEmptySealed=ok "
                "badProtection=ok removeNoCallback=ok sealed=true opened=true dsealed=true "
                "dopened=true probeDevice=true probePresence=true removed=true "
                "probeGone=factor-invalidated auth=true missing=factor-invalidated "
                "cancelled=cancelled unavailable=unavailable/fail:unavailable "
                "nolockscreen=verification-unavailable/fail:nolockscreen "
                "failed=unavailable clear=true",
      "keystore-binding: bridge behaviour drifted");
  const auto calls = qntxTestKeystore::calls();
  CHECK(calls.size() == 15, "keystore-binding: expected fifteen platform calls");
  CHECK(!calls.empty() && calls[0].op == "seal" && calls[0].title == "保护钱包" &&
            calls[0].bytes == 32,
      "keystore-binding: seal did not reach the platform verbatim");
  CHECK(calls.size() > 1 && calls[1].op == "open" &&
            calls[1].description == "验证身份以解锁钱包",
      "keystore-binding: open prompt did not reach the platform verbatim");
  return g_failures;
}

// A lock while a prompt is on screen: teardown dismisses it through
// keystoreCancel, and the late completion is dropped without touching the
// dead runtime (ASan/TSan builds catch a use-after-free here).
int keystoreTeardown() {
  qntxTestKeystore::reset();
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
__qntx.keystore.authenticate("t", "d", function () { __send("late"); });
__send("held");
)JS";
  qntxTestKeystore::holdNext();
  auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(30)), "keystore-teardown: no post");
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "keystore-teardown: runtime still running");
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  CHECK(qntxTestKeystore::cancels() == 1, "keystore-teardown: teardown did not cancel the prompt");
  CHECK(!qntxTestKeystore::releaseHeld(), "keystore-teardown: the held call survived cancel");
  std::lock_guard<std::mutex> lock(box.m);
  CHECK(box.posts.size() == 1, "keystore-teardown: a completion reached the dead runtime");
  CHECK(box.errors.empty(), "keystore-teardown: unexpected onError");
  return g_failures;
}

// The passkey bridge: the request JSON reaches the platform verbatim, the
// response JSON comes back on the kernel thread with PRF outputs as separate
// Uint8Arrays, failures map to kernel error
// codes, bad arguments throw, and teardown cancels a held ceremony.
int passkeyBinding() {
  qntxTestPasskey::reset();
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
var pk = __qntx.passkey;
var r = ["frozen=" + Object.isFrozen(pk)];
function throws(name, fn) {
  try { fn(); r.push(name + "=nothrow"); } catch (e) { r.push(name + "=ok"); }
}
throws("empty", function () { pk.create("", function () {}); });
throws("long", function () { pk.get(new Array(16 * 1024 + 2).join("x"), function () {}); });
throws("noCallback", function () { pk.get("{}", 1); });
function step(fn) { return new Promise(function (resolve) { fn(function (value, code, detail, prf) { resolve([value, code, detail, prf]); }); }); }
function filled(bytes, value) { return bytes instanceof Uint8Array && bytes.length === 32 && bytes.every(function (b) { return b === value; }); }
step(function (cb) { pk.create('{"rp":"x"}', cb); }).then(function (c) {
  r.push("create=" + (c[0] === '{"echo":{"rp":"x"}}' && c[1] === undefined && c[3] === undefined));
  return step(function (cb) { pk.get('{"m":"prf"}', cb); });
}).then(function (c) {
  r.push("prf=" + (c[0] === '{"echo":{"m":"prf"}}' && filled(c[3].first, 7) && filled(c[3].second, 8)));
  return step(function (cb) { pk.get('{"m":"fail:cancelled"}', cb); });
}).then(function (c) {
  r.push("cancelled=" + c[1] + "/" + c[2]);
  return step(function (cb) { pk.get('{"m":"fail:unavailable"}', cb); });
}).then(function (c) {
  r.push("unavailable=" + c[1] + "/" + c[2]);
  return step(function (cb) { pk.get('{"m":"fail:notconfigured"}', cb); });
}).then(function (c) {
  r.push("notconfigured=" + c[1] + "/" + c[2]);
  return step(function (cb) { pk.get('{"m":"fail:unsupported"}', cb); });
}).then(function (c) {
  r.push("unsupported=" + c[1] + "/" + c[2]);
  return step(function (cb) { pk.create('{"m":"fail:failed"}', cb); });
}).then(function (c) {
  r.push("failed=" + c[1]);
  __send(r.join(" "));
  pk.get('{"m":"hold"}', function () { __send("late"); });
});
)JS";
  auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(30)), "passkey-binding: no report");
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "passkey-binding: runtime still running");
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  CHECK(qntxTestPasskey::cancels() == 1, "passkey-binding: teardown did not cancel the ceremony");
  std::lock_guard<std::mutex> lock(box.m);
  CHECK(box.posts.size() == 1 &&
            box.posts[0] ==
                "frozen=true empty=ok long=ok noCallback=ok create=true prf=true "
                "cancelled=cancelled/fail:cancelled unavailable=unavailable/fail:unavailable "
                "notconfigured=passkey-not-configured/fail:notconfigured "
                "unsupported=unsupported/fail:unsupported failed=unavailable",
      "passkey-binding: bridge behaviour drifted");
  for (const auto& error : box.errors) {
    std::fprintf(stderr, "passkey-binding onError: %s\n", error.c_str());
  }
  CHECK(box.errors.empty(), "passkey-binding: unexpected onError");
  return g_failures;
}

// The card-reader bridge: the prompt reaches the platform verbatim, an ok
// open connects the session, transmit echoes come back as Uint8Arrays, every
// failure status ends the session with a silent platform close — and an
// ended session fails the next transmit with the same code without touching
// the platform — and the kernel's own misuse throws.
int cardReaderBinding() {
  qntxTestCardReader::reset();
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
var cr = __qntx.cardReader;
var r = ["frozen=" + Object.isFrozen(cr)];
r.push("names=" + Object.getOwnPropertyNames(cr).sort().join(","));
function throws(name, fn) {
  try { fn(); r.push(name + "=nothrow"); } catch (e) { r.push(name + "=ok"); }
}
function step(fn) { return new Promise(function (resolve) { fn(function (a, b, c) { resolve([a, b, c]); }); }); }
throws("openNoArgs", function () { cr.open(); });
throws("openEmpty", function () { cr.open("", function () {}); });
throws("openLong", function () { cr.open(new Array(1026).join("x"), function () {}); });
throws("openNoCb", function () { cr.open("ok"); });
throws("txBeforeOpen", function () { cr.transmit(new Uint8Array(4), function () {}); });
throws("txShort", function () { cr.transmit(new Uint8Array(3), function () {}); });
throws("txLong", function () { cr.transmit(new Uint8Array(262), function () {}); });
throws("txObject", function () { cr.transmit({ length: 4 }, function () {}); });
throws("txNoCb", function () { cr.transmit(new Uint8Array(4), 1); });
throws("closeNoArgs", function () { cr.close(); });
throws("closeOutcome", function () { cr.close("stale", ""); });
throws("closeLong", function () { cr.close("success", new Array(1026).join("x")); });
cr.close("success", "no-op");
step(function (cb) { cr.open("读卡中", cb); }).then(function (o) {
  r.push("open=" + (o[0] === undefined && o[1] === undefined));
  throws("doubleOpen", function () { cr.open("again", function () {}); });
  throws("txShortC", function () { cr.transmit(new Uint8Array(3), function () {}); });
  throws("txLongC", function () { cr.transmit(new Uint8Array(262), function () {}); });
  return step(function (cb) { cr.transmit(new Uint8Array([0, 0xA4, 4, 0, 1, 2, 3]), cb); });
}).then(function (t) {
  var ok = t[0] instanceof Uint8Array && t[0].length === 5 && t[0][0] === 3 &&
      t[0][1] === 2 && t[0][2] === 1 && t[0][3] === 0x90 && t[0][4] === 0;
  r.push("echo=" + ok + "/" + t[1]);
  var held = step(function (cb) { cr.transmit(new Uint8Array([0, 0xEF, 0, 0]), cb); });
  throws("txInflight", function () { cr.transmit(new Uint8Array(4), function () {}); });
  cr.close("failure", "中止");
  return held;
}).then(function (h) {
  r.push("held=" + h[1]);
  throws("txAfterClose", function () { cr.transmit(new Uint8Array(4), function () {}); });
  cr.close("success", "ignored");
  return step(function (cb) { cr.open("s2", cb); });
}).then(function (o2) {
  r.push("reopen=" + (o2[0] === undefined && o2[1] === undefined));
  return step(function (cb) { cr.transmit(new Uint8Array([0, 0xEE, 0, 0]), cb); });
}).then(function (t2) {
  r.push("tagLost=" + t2[1]);
  return step(function (cb) { cr.transmit(new Uint8Array([0, 0xB0, 0, 0]), cb); });
}).then(function (t3) {
  r.push("ended=" + t3[1] + "/" + t3[2]);
  cr.close("failure", "");
  return step(function (cb) { cr.open("fail:timeout", cb); });
}).then(function (o3) {
  r.push("timeout=" + o3[0] + "/" + o3[1]);
  return step(function (cb) { cr.open("fail:cancelled", cb); });
}).then(function (o4) {
  r.push("cancelled=" + o4[0] + "/" + o4[1]);
  return step(function (cb) { cr.open("fail:tag-lost", cb); });
}).then(function (o5) {
  r.push("lost=" + o5[0]);
  return step(function (cb) { cr.open("fail:interrupted", cb); });
}).then(function (o6) {
  r.push("interrupted=" + o6[0]);
  return step(function (cb) { cr.open("fail:unavailable", cb); });
}).then(function (o7) {
  r.push("unavailable=" + o7[0]);
  return step(function (cb) { cr.open("s3", cb); });
}).then(function (o8) {
  r.push("open3=" + (o8[0] === undefined));
  return step(function (cb) { cr.transmit(new Uint8Array([0, 0xB0, 0, 0]), cb); });
}).then(function (t4) {
  r.push("badResponse=" + t4[1] + "/" + t4[2]);
  return step(function (cb) { cr.open("s4", cb); });
}).then(function (o9) {
  cr.close("success", "完成");
  __send(r.join(" "));
});
)JS";
  {
    auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
    CHECK(box.waitPosts(1, std::chrono::seconds(30)), "card-reader-binding: no report");
    rt->destroy();
    CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  }
  std::lock_guard<std::mutex> lock(box.m);
  CHECK(box.posts.size() == 1 &&
            box.posts[0] ==
                "frozen=true names=close,open,transmit "
                "openNoArgs=ok openEmpty=ok openLong=ok openNoCb=ok txBeforeOpen=ok "
                "txShort=ok txLong=ok txObject=ok txNoCb=ok closeNoArgs=ok "
                "closeOutcome=ok closeLong=ok open=true doubleOpen=ok txShortC=ok txLongC=ok "
                "echo=true/undefined txInflight=ok held=cancelled txAfterClose=ok reopen=true "
                "tagLost=tag-lost ended=tag-lost/undefined timeout=timeout/fail:timeout "
                "cancelled=cancelled/fail:cancelled lost=tag-lost interrupted=interrupted "
                "unavailable=unavailable open3=true "
                "badResponse=unavailable/qntx:bad-response",
      "card-reader-binding: bridge behaviour drifted");
  CHECK(qntxTestCardReader::opens() == 9, "card-reader-binding: platform saw a bad open");
  CHECK(qntxTestCardReader::transmits() == 4,
      "card-reader-binding: an ended session's transmit reached the platform");
  const auto closes = qntxTestCardReader::closes();
  CHECK(closes.size() == 9, "card-reader-binding: unexpected platform closes");
  if (closes.size() == 9) {
    CHECK(!closes[0].success && closes[0].text == "中止",
        "card-reader-binding: the kernel's close text did not reach the platform");
    for (size_t i = 1; i < 8; i++) {
      CHECK(!closes[i].success && closes[i].text.empty(),
          "card-reader-binding: a failure close was not silent");
    }
    CHECK(closes[8].success && closes[8].text == "完成",
        "card-reader-binding: the success close did not reach the platform");
  }
  for (const auto& error : box.errors) {
    std::fprintf(stderr, "card-reader-binding onError: %s\n", error.c_str());
  }
  CHECK(box.errors.empty(), "card-reader-binding: unexpected onError");
  return g_failures;
}

// Process-wide ownership: while one runtime owns the reader, another's open
// completes unavailable/qntx:busy without ever reaching the platform; after
// the owner is torn down the reader is free again.
int cardReaderBusy() {
  qntxTestCardReader::reset();
  Mailbox box1;
  Mailbox box2;
  const std::string js1 = std::string(kSendHelper) + R"JS(
__qntx.cardReader.open("r1", function (code) {
  __send("r1:" + code);
});
)JS";
  const std::string js2 = std::string(kSendHelper) + R"JS(
var cr = __qntx.cardReader;
var tries = 0;
function openOnce() {
  tries++;
  cr.open("r2", function (code, detail) {
    if (code === undefined) {
      __send("r2-opened:" + tries);
      return;
    }
    if (tries === 1) {
      __send("r2-busy:" + code + "/" + detail);
    }
    setTimeout(openOnce, 20);
  });
}
openOnce();
)JS";
  auto rt1 = KernelRuntime::start(sourceScript(js1), hooksFor(box1), "");
  CHECK(box1.waitPosts(1, std::chrono::seconds(30)), "card-reader-busy: owner never opened");
  auto rt2 = KernelRuntime::start(sourceScript(js2), hooksFor(box2), "");
  CHECK(box2.waitPosts(1, std::chrono::seconds(30)), "card-reader-busy: contender never answered");
  {
    std::lock_guard<std::mutex> lock(box1.m);
    CHECK(box1.posts.size() == 1 && box1.posts[0] == "r1:undefined",
        "card-reader-busy: the owner's open did not connect");
  }
  {
    std::lock_guard<std::mutex> lock(box2.m);
    CHECK(box2.posts.size() == 1 && box2.posts[0] == "r2-busy:unavailable/qntx:busy",
        "card-reader-busy: a busy open did not complete unavailable");
  }
  CHECK(qntxTestCardReader::opens() == 1, "card-reader-busy: a busy open reached the platform");
  rt1->destroy();
  CHECK(rt1->waitUntilStopped(std::chrono::seconds(5)), "card-reader-busy: owner still running");
  {
    const auto closes = qntxTestCardReader::closes();
    CHECK(closes.size() == 1 && !closes[0].success && closes[0].text.empty(),
        "card-reader-busy: teardown did not close the owner's session silently");
  }
  CHECK(box2.waitPosts(2, std::chrono::seconds(30)),
      "card-reader-busy: contender never opened after release");
  rt2->destroy();
  CHECK(rt2->waitUntilStopped(std::chrono::seconds(5)), "card-reader-busy: contender still running");
  {
    std::lock_guard<std::mutex> lock(box2.m);
    CHECK(box2.posts.size() == 2 && box2.posts[1].rfind("r2-opened:", 0) == 0,
        "card-reader-busy: the contender did not open after release");
  }
  CHECK(qntxTestCardReader::opens() == 2, "card-reader-busy: released open did not reach the platform");
  return g_failures;
}

// Teardown with a held open and a held transmit: the session is closed
// silently on the kernel thread, ownership is released, and the platform's
// late completions are dropped without touching the dead runtime.
int cardReaderTeardown() {
  {
    qntxTestCardReader::reset();
    Mailbox box;
    const std::string js = std::string(kSendHelper) + R"JS(
__qntx.cardReader.open("hold", function (code) {
  __send("late-open:" + code);
});
__send("held");
)JS";
    auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
    CHECK(box.waitPosts(1, std::chrono::seconds(30)), "card-reader-teardown: open not parked");
    CHECK(qntxTestCardReader::opens() == 1, "card-reader-teardown: open never reached the platform");
    rt->destroy();
    CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "card-reader-teardown: runtime still running");
    auto closes = qntxTestCardReader::closes();
    CHECK(closes.size() == 1 && !closes[0].success && closes[0].text.empty(),
        "card-reader-teardown: teardown did not close the held session silently");
    CHECK(qntxTestCardReader::fireHeld(), "card-reader-teardown: the held open was not held");
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    std::lock_guard<std::mutex> lock(box.m);
    CHECK(box.posts.size() == 1, "card-reader-teardown: a completion reached the dead runtime");
    CHECK(box.errors.empty(), "card-reader-teardown: unexpected onError");
  }
  {
    qntxTestCardReader::reset();
    Mailbox box;
    const std::string js = std::string(kSendHelper) + R"JS(
__qntx.cardReader.open("s", function (code) {
  __qntx.cardReader.transmit(new Uint8Array([0, 0xEF, 0, 0]), function (v, c) {
    __send("late-tx:" + c);
  });
  __send("tx-parked");
});
)JS";
    auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
    CHECK(box.waitPosts(1, std::chrono::seconds(30)), "card-reader-teardown: transmit not parked");
    rt->destroy();
    CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "card-reader-teardown: runtime still running");
    const auto closes = qntxTestCardReader::closes();
    CHECK(closes.size() == 1 && !closes[0].success && closes[0].text.empty(),
        "card-reader-teardown: teardown did not close the live session silently");
    CHECK(qntxTestCardReader::fireHeld(), "card-reader-teardown: the held transmit was not held");
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    std::lock_guard<std::mutex> lock(box.m);
    CHECK(box.posts.size() == 1, "card-reader-teardown: a completion reached the dead runtime");
    CHECK(box.errors.empty(), "card-reader-teardown: unexpected onError");
  }
  // A completion that lands after the kernel's own close but while the
  // runtime still lives is dropped: it must not report to JS or close the
  // platform session a second time.
  {
    qntxTestCardReader::reset();
    Mailbox box;
    const std::string js = std::string(kSendHelper) + R"JS(
__qntx.cardReader.open("s", function (code) {
  __qntx.cardReader.transmit(new Uint8Array([0, 0xEF, 0, 0]), function (v, c) {
    __send("late-tx:" + c);
  });
  __qntx.cardReader.close("failure", "");
  __send("closed");
});
)JS";
    auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
    CHECK(box.waitPosts(2, std::chrono::seconds(30)), "card-reader-teardown: session not closed");
    CHECK(qntxTestCardReader::closes().size() == 1,
        "card-reader-teardown: the kernel's close never reached the platform");
    CHECK(qntxTestCardReader::fireHeld(), "card-reader-teardown: the held transmit was not held");
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    rt->destroy();
    CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "card-reader-teardown: runtime still running");
    {
      const auto closes = qntxTestCardReader::closes();
      CHECK(closes.size() == 1, "card-reader-teardown: a late completion closed the session again");
      std::lock_guard<std::mutex> lock(box.m);
      // The kernel's own close settled the in-flight transmit cancelled,
      // exactly once, asynchronously after "closed"; the late tag-lost must
      // not resolve it again.
      CHECK(
          box.posts.size() == 2 && box.posts[0] == "closed" &&
              box.posts[1] == "late-tx:cancelled",
          "card-reader-teardown: a late completion re-settled the closed call");
      CHECK(box.errors.empty(), "card-reader-teardown: unexpected onError");
    }
  }
  return g_failures;
}

// A platform answer for a call the kernel already closed must not touch the
// session that replaced it: an old ok must not mark the new session
// connected, an old failure must not end it or close the new platform
// session. Run once with the stale answer ok, once with a failure.
int cardReaderStale() {
  for (const bool staleFails : {false, true}) {
    qntxTestCardReader::reset();
    Mailbox box;
    const std::string js = std::string(kSendHelper) + R"JS(
var cr = __qntx.cardReader;
cr.open("hold", function (code) { __send("stale:" + code); });
cr.close("failure", "");
cr.open("hold", function (o) {
  __send("open2:" + (o === undefined));
  cr.transmit(new Uint8Array([0, 0xA4, 0, 0, 7]), function (v, c) {
    cr.close("success", "done");
    __send("tx:" + (v instanceof Uint8Array && v.length === 3 && v[0] === 7) + ":" + c);
  });
});
)JS";
    auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
    // The kernel's own close settles the held first open cancelled.
    const bool firstPosts = box.waitPosts(1, std::chrono::seconds(30));
    if (!firstPosts) {
      box.dump();
    }
    CHECK(firstPosts, "card-reader-stale: close never settled");
    {
      std::lock_guard<std::mutex> lock(box.m);
      CHECK(box.posts[0] == "stale:cancelled", "card-reader-stale: the held open settled wrong");
    }
    // The stale answer for the first session lands while the second is
    // still opening — held at the platform until we release it.
    const qntx::CardReaderResult stale =
        staleFails ? qntx::CardReaderResult{qntx::CardReaderStatus::tagLost, {}, "old"}
                   : qntx::CardReaderResult{qntx::CardReaderStatus::ok, {}, {}};
    CHECK(qntxTestCardReader::fireHeldAs(stale), "card-reader-stale: the first open was not held");
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    CHECK(
        qntxTestCardReader::fireHeldAs(qntx::CardReaderResult{qntx::CardReaderStatus::ok, {}, {}}),
        "card-reader-stale: the second open was not held");
    const bool sessionPosts = box.waitPosts(3, std::chrono::seconds(30));
    if (!sessionPosts) {
      box.dump();
    }
    CHECK(sessionPosts, "card-reader-stale: session two broke");
    {
      const auto closes = qntxTestCardReader::closes();
      // Exactly the kernel's own silent failure close and its closing
      // message — a stale answer must not close the new platform session.
      CHECK(
          closes.size() == 2 && !closes[0].success && closes[0].text.empty() &&
              closes[1].success && closes[1].text == "done",
          "card-reader-stale: a stale completion closed or broke the new session");
      std::lock_guard<std::mutex> lock(box.m);
      CHECK(
          box.posts.size() == 3 && box.posts[1] == "open2:true" && box.posts[2] == "tx:true:undefined",
          "card-reader-stale: the new session answered wrong");
      CHECK(box.errors.empty(), "card-reader-stale: unexpected onError");
    }
    rt->destroy();
    CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "card-reader-stale: runtime still running");
  }
  {
    // The same rule for a held transmit: open ok, park a transmit, close,
    // reopen, then fire the old transmit's answer at the new session.
    qntxTestCardReader::reset();
    Mailbox box;
    const std::string js = std::string(kSendHelper) + R"JS(
var cr = __qntx.cardReader;
function step(fn) { return new Promise(function (resolve) { fn(function (a, b, c) { resolve([a, b, c]); }); }); }
step(function (cb) { cr.open("s", cb); }).then(function () {
  cr.transmit(new Uint8Array([0, 0xEF, 0, 0]), function (v, c) { __send("stale-tx:" + c); });
  cr.close("failure", "");
  return step(function (cb) { cr.open("s2", cb); });
}).then(function (o) {
  __send("open2:" + (o[0] === undefined));
  return step(function (cb) { cr.transmit(new Uint8Array([0, 0xA4, 0, 0, 9]), cb); });
}).then(function (t) {
  cr.close("success", "done");
  __send("tx:" + (t[0] instanceof Uint8Array && t[0].length === 3 && t[0][0] === 9) + ":" + t[1]);
});
)JS";
    auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
    const bool staleTxPosts = box.waitPosts(1, std::chrono::seconds(30));
    if (!staleTxPosts) {
      box.dump();
    }
    CHECK(staleTxPosts, "card-reader-stale: close never settled");
    {
      std::lock_guard<std::mutex> lock(box.m);
      CHECK(box.posts[0] == "stale-tx:cancelled", "card-reader-stale: the held transmit settled wrong");
    }
    CHECK(
        qntxTestCardReader::fireHeldAs(
            qntx::CardReaderResult{qntx::CardReaderStatus::tagLost, {}, "old"}),
        "card-reader-stale: the transmit was not held");
    const bool newSessionPosts = box.waitPosts(3, std::chrono::seconds(30));
    if (!newSessionPosts) {
      box.dump();
    }
    CHECK(newSessionPosts, "card-reader-stale: session two broke");
    {
      const auto closes = qntxTestCardReader::closes();
      CHECK(
          closes.size() == 2 && !closes[0].success && closes[1].success,
          "card-reader-stale: a stale transmit answer closed the new session");
      std::lock_guard<std::mutex> lock(box.m);
      CHECK(
          box.posts.size() == 3 && box.posts[1] == "open2:true" && box.posts[2] == "tx:true:undefined",
          "card-reader-stale: the new session answered wrong");
      CHECK(box.errors.empty(), "card-reader-stale: unexpected onError");
    }
    rt->destroy();
    CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "card-reader-stale: runtime still running");
  }
  return g_failures;
}

// The secure-input bridge: requests arm the shared hub's prompt, a view's
// submit returns the bytes as a fresh Uint8Array, a bad submit is refused
// without completing, cancel maps to cancelled, a second request of the same
// runtime throws and another runtime's request completes unavailable.
int secureInputBinding() {
  Mailbox box;
  Mailbox box2;
  std::mutex sinkMutex;
  std::condition_variable sinkCv;
  std::vector<std::optional<qntx::SecureInputPrompt>> prompts;
  auto& hub = qntx::SecureInputHub::shared();
  const uint64_t view = hub.attach([&](const std::optional<qntx::SecureInputPrompt>& prompt) {
    std::lock_guard<std::mutex> lock(sinkMutex);
    prompts.push_back(prompt);
    sinkCv.notify_all();
  });
  const std::string js = std::string(kSendHelper) + R"JS(
var si = __qntx.secureInput;
var r = ["frozen=" + Object.isFrozen(si)];
r.push("names=" + Object.getOwnPropertyNames(si).sort().join(","));
function throws(name, fn) {
  try { fn(); r.push(name + "=nothrow"); } catch (e) { r.push(name + "=ok"); }
}
function text(v) {
  if (!(v instanceof Uint8Array)) { return "not-bytes"; }
  var s = "";
  for (var i = 0; i < v.length; i++) { s += String.fromCharCode(v[i]); }
  return s;
}
throws("noArgs", function () { si.request(); });
throws("badKind", function () { si.request("pin", "l", function () {}); });
throws("emptyLabel", function () { si.request("access-code", "", function () {}); });
throws("longLabel", function () { si.request("access-code", new Array(2050).join("x"), function () {}); });
throws("label2048", function () {
  si.request("access-code", new Array(2049).join("x"), function () {});
  si.cancel();
});
throws("noCb", function () { si.request("access-code", "l"); });
si.request("access-code", "输入访问码", function (v, c) {
  r.push("req1=" + text(v));
  si.request("access-code", "取消", function (v2, c2) {
    r.push("cancelled=" + c2);
    si.request("access-code", "访问码", function (v3, c3) {
      r.push("code=" + text(v3));
      si.request("short-id", "卡号", function (v4, c4) {
        r.push("sid=" + text(v4));
        si.request("access-code", "再试", function (v5, c5) {
          r.push("afterBad=" + text(v5));
          __send(r.join(" "));
        });
        __send("want-bad");
      });
      __send("want-sid");
    });
    __send("want-code");
  });
  si.cancel();
});
throws("double", function () { si.request("access-code", "x", function () {}); });
__send("armed");
)JS";
  const std::string js2 = std::string(kSendHelper) + R"JS(
__qntx.secureInput.request("access-code", "r2", function (v, c) {
  __send("r2:" + c);
});
)JS";
  auto submit = [&](std::vector<uint8_t> bytes) {
    return hub.submit(view, qntx::SecretBytes(std::move(bytes)));
  };
  auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(30)), "secure-input-binding: never armed");
  {
    auto rt2 = KernelRuntime::start(sourceScript(js2), hooksFor(box2), "");
    CHECK(box2.waitPosts(1, std::chrono::seconds(30)),
        "secure-input-binding: contender never answered");
    rt2->destroy();
    CHECK(rt2->waitUntilStopped(std::chrono::seconds(5)), "secure-input-binding: contender still running");
  }
  {
    std::lock_guard<std::mutex> lock(box2.m);
    CHECK(box2.posts.size() == 1 && box2.posts[0] == "r2:unavailable",
        "secure-input-binding: another runtime's request did not complete unavailable");
  }
  CHECK(submit({'S', '3', 'c', 'r', '3', 't'}), "secure-input-binding: access-code submit refused");
  CHECK(box.waitPosts(2, std::chrono::seconds(30)), "secure-input-binding: cancel path stalled");
  CHECK(submit({'a', 'b', 'c', '1', '2', '3'}), "secure-input-binding: second submit refused");
  CHECK(box.waitPosts(3, std::chrono::seconds(30)), "secure-input-binding: short-id path stalled");
  CHECK(submit({'A', '1', 'B', '2', 'C', '3', 'D', '4'}), "secure-input-binding: short-id submit refused");
  CHECK(box.waitPosts(4, std::chrono::seconds(30)), "secure-input-binding: bad-submit path stalled");
  CHECK(!submit({0x0A}), "secure-input-binding: an invalid byte was accepted");
  CHECK(submit({'x', 'y', 'z', '7', '8', '9'}), "secure-input-binding: recovery submit refused");
  CHECK(box.waitPosts(5, std::chrono::seconds(30)), "secure-input-binding: no report");
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "secure-input-binding: runtime still running");
  hub.detach(view);
  std::lock_guard<std::mutex> lock(box.m);
  CHECK(box.posts.size() == 5 &&
            box.posts[4] ==
                "frozen=true names=cancel,request "
                "noArgs=ok badKind=ok emptyLabel=ok longLabel=ok label2048=nothrow noCb=ok "
                "double=ok "
                "req1=S3cr3t cancelled=cancelled code=abc123 sid=A1B2C3D4 afterBad=xyz789",
      "secure-input-binding: bridge behaviour drifted");
  {
    std::lock_guard<std::mutex> sinkLock(sinkMutex);
    CHECK(prompts.size() >= 4 && prompts[3].has_value() &&
              prompts[3]->kind == qntx::SecureInputKind::accessCode &&
              prompts[3]->label == "输入访问码",
        "secure-input-binding: the prompt did not reach the view verbatim");
  }
  for (const auto& error : box.errors) {
    std::fprintf(stderr, "secure-input-binding onError: %s\n", error.c_str());
  }
  CHECK(box.errors.empty(), "secure-input-binding: unexpected onError");
  return g_failures;
}

// Teardown with a pending request: the hub drops it without ever calling
// done, the views are cleared, and a late submit finds nothing pending.
int secureInputTeardown() {
  Mailbox box;
  std::atomic<int> prompts{0};
  auto& hub = qntx::SecureInputHub::shared();
  const uint64_t view = hub.attach(
      [&](const std::optional<qntx::SecureInputPrompt>&) { prompts += 1; });
  const std::string js = std::string(kSendHelper) + R"JS(
__qntx.secureInput.request("access-code", "码", function () { __send("late"); });
__send("armed");
)JS";
  auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(30)), "secure-input-teardown: never armed");
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "secure-input-teardown: runtime still running");
  CHECK(!hub.submit(view, qntx::SecretBytes(std::vector<uint8_t>{'a'})),
      "secure-input-teardown: the request survived teardown");
  hub.detach(view);
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
  std::lock_guard<std::mutex> lock(box.m);
  CHECK(box.posts.size() == 1, "secure-input-teardown: done ran on a dead runtime");
  CHECK(box.errors.empty(), "secure-input-teardown: unexpected onError");
  // attach's own empty prompt, the request's prompt, teardown's clear, and
  // the refused submit's clear of the submitting view.
  CHECK(prompts.load() == 4, "secure-input-teardown: the view was not cleared");
  return g_failures;
}

// The hub on its own, no runtime: one pending request process-wide, submit
// refuses bad bytes for the kind (and leaves the request pending), cancel
// completes with cancelled, release drops without completing, and attach
// replays the current prompt.
int secureInputHubCase() {
  qntx::SecureInputHub hub;
  std::vector<std::optional<qntx::SecureInputPrompt>> seen;
  const uint64_t view = hub.attach(
      [&](const std::optional<qntx::SecureInputPrompt>& prompt) { seen.push_back(prompt); });
  CHECK(seen.size() == 1 && !seen[0].has_value(), "secure-input-hub: attach replayed a prompt");
  CHECK(!hub.submit(view, qntx::SecretBytes(std::vector<uint8_t>{'a'})),
      "secure-input-hub: submit without a request");
  CHECK(seen.size() == 2 && !seen[1].has_value(),
      "secure-input-hub: a refused submit did not clear the view");
  int calls = 0;
  std::optional<qntx::SecureInputFailure> lastFailure;
  qntx::SecretBytes lastValue;
  const void* ownerA = &hub;
  const void* ownerB = &ownerA;
  auto arm = [&](const void* owner, qntx::SecureInputKind kind) {
    return hub.request(
        owner, kind, "label", [&](qntx::SecureInputResult result) {
          calls += 1;
          lastFailure = result.failure;
          lastValue = std::move(result.value);
        });
  };
  auto trySubmit = [&](std::vector<uint8_t> bytes) {
    return hub.submit(view, qntx::SecretBytes(std::move(bytes)));
  };
  CHECK(arm(ownerA, qntx::SecureInputKind::accessCode) == qntx::SecureInputArm::armed,
      "secure-input-hub: first request not armed");
  CHECK(arm(ownerA, qntx::SecureInputKind::accessCode) == qntx::SecureInputArm::busySelf,
      "secure-input-hub: own second request not refused");
  CHECK(arm(ownerB, qntx::SecureInputKind::accessCode) == qntx::SecureInputArm::busyOther,
      "secure-input-hub: foreign request not refused");
  CHECK(!trySubmit({}), "secure-input-hub: empty access code accepted");
  CHECK(!trySubmit(std::vector<uint8_t>(65, 'a')), "secure-input-hub: 65-byte access code accepted");
  CHECK(!trySubmit({0x1F}), "secure-input-hub: byte below 0x20 accepted");
  CHECK(!trySubmit({0x7F}), "secure-input-hub: byte above 0x7E accepted");
  CHECK(trySubmit(std::vector<uint8_t>(64, 'a')), "secure-input-hub: 64-byte access code refused");
  CHECK(calls == 1 && !lastFailure.has_value() && lastValue.size() == 64,
      "secure-input-hub: a valid submit did not complete");
  CHECK(arm(ownerA, qntx::SecureInputKind::shortId) == qntx::SecureInputArm::armed,
      "secure-input-hub: second request not armed");
  CHECK(!trySubmit({'A', '1', 'B', '2', 'C', '3', 'D'}), "secure-input-hub: 7-byte short id accepted");
  CHECK(!trySubmit({'A', '1', 'B', '2', 'C', '3', 'D', '4', '5'}),
      "secure-input-hub: 9-byte short id accepted");
  CHECK(!trySubmit({'a', '1', 'b', '2', 'c', '3', 'd', '4'}),
      "secure-input-hub: lower-case short id accepted");
  CHECK(!trySubmit({'G', '1', 'B', '2', 'C', '3', 'D', '4'}),
      "secure-input-hub: non-hex short id accepted");
  CHECK(trySubmit({'0', '1', '2', '3', 'A', 'B', 'C', 'D'}),
      "secure-input-hub: valid short id refused");
  CHECK(calls == 2 && !lastFailure.has_value() && lastValue.size() == 8,
      "secure-input-hub: a valid short id did not complete");
  CHECK(arm(ownerA, qntx::SecureInputKind::backupPassword) == qntx::SecureInputArm::armed,
      "secure-input-hub: backup-password request not armed");
  CHECK(!trySubmit({}), "secure-input-hub: empty backup password accepted");
  CHECK(!trySubmit(std::vector<uint8_t>(1025, 'a')),
      "secure-input-hub: 1025-byte backup password accepted");
  CHECK(!trySubmit({0xC0, 0xAF}), "secure-input-hub: overlong UTF-8 accepted");
  CHECK(!trySubmit({0xED, 0xA0, 0x80}), "secure-input-hub: a UTF-16 surrogate accepted");
  // "pässwörd" — multi-byte UTF-8 throughout.
  CHECK(trySubmit({0x70, 0xC3, 0xA4, 0x73, 0x73, 0x77, 0xC3, 0xB6, 0x72, 0x64}),
      "secure-input-hub: UTF-8 backup password refused");
  CHECK(calls == 3 && !lastFailure.has_value() && lastValue.size() == 10,
      "secure-input-hub: a valid backup password did not complete");
  CHECK(arm(ownerA, qntx::SecureInputKind::sessionApproval) == qntx::SecureInputArm::armed,
      "secure-input-hub: session-approval request not armed");
  CHECK(!trySubmit({}), "secure-input-hub: empty approval code accepted");
  CHECK(!trySubmit({'0', '1', '2'}), "secure-input-hub: 3-digit approval code accepted");
  CHECK(!trySubmit({'0', '1', '2', '3', '4'}),
      "secure-input-hub: 5-digit approval code accepted");
  CHECK(!trySubmit({'1', '2', 'a', '4'}), "secure-input-hub: non-digit approval code accepted");
  CHECK(trySubmit({'0', '4', '2', '7'}), "secure-input-hub: valid approval code refused");
  CHECK(calls == 4 && !lastFailure.has_value() && lastValue.size() == 4,
      "secure-input-hub: a valid approval code did not complete");
  CHECK(arm(ownerA, qntx::SecureInputKind::accessCode) == qntx::SecureInputArm::armed,
      "secure-input-hub: third request not armed");
  hub.cancel(ownerB);
  CHECK(calls == 4, "secure-input-hub: a foreign cancel completed the request");
  hub.cancel(ownerA);
  CHECK(calls == 5 && lastFailure == qntx::SecureInputFailure::cancelled,
      "secure-input-hub: cancel did not complete cancelled");
  CHECK(arm(ownerA, qntx::SecureInputKind::accessCode) == qntx::SecureInputArm::armed,
      "secure-input-hub: fourth request not armed");
  hub.release(ownerA);
  CHECK(calls == 5, "secure-input-hub: release ran the completion");
  CHECK(!trySubmit({'a'}), "secure-input-hub: submit after release");
  hub.detach(view);
  CHECK(seen.size() >= 5 && seen[2].has_value() && seen[2]->label == "label" &&
            !seen.back().has_value(),
      "secure-input-hub: the view did not see prompt and clear");
  // Ordering: the clear reaches the views before the completion, so a request
  // armed from inside done() is the last prompt a view observes — the view can
  // never be left idle while a request is pending.
  {
    std::vector<std::optional<qntx::SecureInputPrompt>> order;
    const uint64_t v2 = hub.attach(
        [&](const std::optional<qntx::SecureInputPrompt>& p) { order.push_back(p); });
    hub.request(
        ownerA, qntx::SecureInputKind::accessCode, "first",
        [&](qntx::SecureInputResult) {
          hub.request(
              ownerA, qntx::SecureInputKind::accessCode, "second",
              [](qntx::SecureInputResult) {});
        });
    CHECK(hub.submit(v2, qntx::SecretBytes(std::vector<uint8_t>{'k'})),
        "secure-input-hub: ordering submit refused");
    CHECK(order.back().has_value() && order.back()->label == "second",
        "secure-input-hub: the submit clear overtook a request armed inside done");
    hub.release(ownerA);
    hub.request(
        ownerA, qntx::SecureInputKind::accessCode, "third",
        [&](qntx::SecureInputResult) {
          hub.request(
              ownerA, qntx::SecureInputKind::accessCode, "fourth",
              [](qntx::SecureInputResult) {});
        });
    hub.cancel(ownerA);
    CHECK(order.back().has_value() && order.back()->label == "fourth",
        "secure-input-hub: the cancel clear overtook a request armed inside done");
    hub.release(ownerA);
    hub.detach(v2);
  }
  return g_failures;
}

// The qs_* bridge: views pass bytes (respecting byteOffset), nonzero codes
// throw `qntx_spark:<code>`, integer args are validated as doubles before the
// cast, and every emitted output is freed through qs_free exactly once — the
// fake's tracker asserts the last invariant across success and error paths.
int backendsSpark() {
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
var r = [];
function hx(u8) {
  var s = "";
  for (var i = 0; i < u8.length; i++) {
    var h = u8[i].toString(16);
    s += h.length < 2 ? "0" + h : h;
  }
  return s;
}
function eq(name, got, want) {
  r.push(name + "=" + (got === want ? "ok" : JSON.stringify(got)));
}
function catches(name, fn, needle) {
  try {
    fn();
    r.push(name + "=nothrow");
  } catch (e) {
    var m = e && e.message ? String(e.message) : "";
    r.push(name + "=" + (m.indexOf(needle) >= 0 ? "ok" : m));
  }
}
var spark = __qntx.backends.spark;
var buf = new Uint8Array([0, 0, 0, 9, 8, 7, 0, 0]);
eq("view", hx(spark.frostSign(new Uint8Array(buf.buffer, 3, 3))), "090807");
eq("commit", hx(spark.frostCommit(new Uint8Array([1, 2]), new Uint8Array([3, 4]))), "01020304");
eq("agg", hx(spark.frostAggregate(new Uint8Array([5, 6]))), "0506");
eq("enc", hx(spark.eciesEncrypt(new Uint8Array([0]), new Uint8Array([0xAA]), new Uint8Array([0]))), "aa");
eq("dec", hx(spark.eciesDecrypt(new Uint8Array([0]), new Uint8Array([0xBB, 0xCC]))), "bbcc");
eq("split", hx(spark.splitSecretWithProofs(new Uint8Array([0x11]), 2, 3, new Uint8Array([0x22]))), "11");
catches("err", function () { spark.frostSign(new Uint8Array([0xFF, 1])); }, "qntx_spark:4");
catches("freedErr", function () { spark.frostCommit(new Uint8Array([0xEE]), new Uint8Array([1])); }, "qntx_spark:5");
var s32 = new Uint8Array(32);
catches("frac", function () { spark.splitSecretWithProofs(s32, 2.5, 3, s32); }, "out of range");
catches("neg", function () { spark.splitSecretWithProofs(s32, -1, 3, s32); }, "out of range");
catches("nan", function () { spark.splitSecretWithProofs(s32, NaN, 3, s32); }, "finite number");
catches("big", function () { spark.splitSecretWithProofs(s32, 4294967296, 3, s32); }, "out of range");
catches("nonint", function () { spark.splitSecretWithProofs(s32, "2", 3, s32); }, "finite number");
__send(r.join(" "));
)JS";
  {
    auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
    CHECK(box.waitPosts(1, std::chrono::seconds(30)), "backends-spark: no report");
    rt->destroy();
    CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  }
  {
    std::lock_guard<std::mutex> lock(box.m);
    CHECK(box.posts.size() == 1 &&
              box.posts[0] ==
                  "view=ok commit=ok agg=ok enc=ok dec=ok split=ok err=ok "
                  "freedErr=ok frac=ok neg=ok nan=ok big=ok nonint=ok",
        "backends-spark: bridge behaviour drifted");
  }
  CHECK(qntxTestSpark::badFrees() == 0, "backends-spark: qs_free saw an unknown pointer or length");
  CHECK(qntxTestSpark::goodFrees() == 7, "backends-spark: expected one free per emitted output");
  CHECK(qntxTestSpark::outstandingAllocs() == 0,
      "backends-spark: an emitted buffer leaked (never reached qs_free)");
  return g_failures;
}

// The nostr_native_* bridge: views pass bytes (respecting byteOffset),
// 32/64-byte inputs are checked exactly, a 0 return throws `nostr_native: <fn>
// rejected the input`, and verifySerialized answers with a boolean.
int backendsNostr() {
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
var r = [];
function hx(u8) {
  var s = "";
  for (var i = 0; i < u8.length; i++) {
    var h = u8[i].toString(16);
    s += h.length < 2 ? "0" + h : h;
  }
  return s;
}
function eq(name, got, want) {
  r.push(name + "=" + (got === want ? "ok" : JSON.stringify(got)));
}
function catches(name, fn, needle) {
  try {
    fn();
    r.push(name + "=nothrow");
  } catch (e) {
    var m = e && e.message ? String(e.message) : "";
    r.push(name + "=" + (m.indexOf(needle) >= 0 ? "ok" : m));
  }
}
var nostr = __qntx.backends.nostr;
var sk = new Uint8Array(32);
for (var i = 0; i < 32; i++) sk[i] = i + 1;
var padded = new Uint8Array(40);
padded.set(sk, 4);
eq("pub", hx(nostr.publicKey(new Uint8Array(padded.buffer, 4, 32))).length, 64);
var idBuf = new Uint8Array(36);
idBuf.fill(0x55);
var id = new Uint8Array(idBuf.buffer, 4, 32);
eq("sigLen", nostr.sign(id, new Uint8Array(padded.buffer, 4, 32), new Uint8Array(32)).length, 64);
var pubBuf = new Uint8Array(36);
pubBuf.fill(0x77);
var pubX = new Uint8Array(pubBuf.buffer, 4, 32);
eq("ecdh", nostr.ecdhX(new Uint8Array(padded.buffer, 4, 32), pubX).length, 32);
eq("verifyTrue", nostr.verifySerialized(new Uint8Array([1, 2, 3]), new Uint8Array(32), new Uint8Array(32), new Uint8Array(64)), true);
eq("verifyFalse", nostr.verifySerialized(new Uint8Array([0, 2]), new Uint8Array(32), new Uint8Array(32), new Uint8Array(64)), false);
eq("verifyLen", nostr.verifySerialized(new Uint8Array([1]), new Uint8Array(31), new Uint8Array(32), new Uint8Array(64)), false);
var bad = new Uint8Array(32);
bad.fill(0xEE);
catches("pubReject", function () { nostr.publicKey(bad); }, "nostr_native: publicKey rejected the input");
catches("signReject", function () { nostr.sign(new Uint8Array(32), bad, new Uint8Array(32)); }, "nostr_native: sign rejected the input");
catches("ecdhReject", function () { nostr.ecdhX(bad, new Uint8Array(32)); }, "nostr_native: ecdhX rejected the input");
catches("len31", function () { nostr.publicKey(new Uint8Array(31)); }, "32-byte view");
catches("len33", function () { nostr.sign(new Uint8Array(32), new Uint8Array(33), new Uint8Array(32)); }, "32-byte view");
__send(r.join(" "));
)JS";
  {
    auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
    CHECK(box.waitPosts(1, std::chrono::seconds(30)), "backends-nostr: no report");
    rt->destroy();
    CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  }
  std::lock_guard<std::mutex> lock(box.m);
  CHECK(box.posts.size() == 1 &&
            box.posts[0] ==
                "pub=ok sigLen=ok ecdh=ok verifyTrue=ok verifyFalse=ok verifyLen=ok "
                "pubReject=ok signReject=ok ecdhReject=ok len31=ok len33=ok",
      "backends-nostr: bridge behaviour drifted");
  {
    uint8_t recorded[64];
    size_t len = 0;
    hostNostrRecordedSerialized(recorded, &len);
    CHECK(len == 2 && recorded[0] == 0 && recorded[1] == 2,
        "backends-nostr: verifySerialized view passed wrong bytes");
    uint8_t signId[32];
    hostNostrRecordedSignId(signId);
    CHECK(signId[0] == 0x55 && signId[31] == 0x55,
        "backends-nostr: sign saw a non-offset id");
    uint8_t ecdhPub[32];
    hostNostrRecordedEcdhPub(ecdhPub);
    CHECK(ecdhPub[0] == 0x77 && ecdhPub[31] == 0x77,
        "backends-nostr: ecdhX saw a non-offset pubkey");
  }
  return g_failures;
}

static std::string makeTempDir() {
  const std::string dir = "/tmp/qntx-file-test-" + std::to_string(::getpid());
  if (::mkdir(dir.c_str(), 0700) != 0) {
    CHECK(false, "file-test: mkdir failed");
    return "";
  }
  return dir;
}

int filePrimitive() {
  const std::string dir = makeTempDir();
  if (dir.empty()) {
    return g_failures;
  }

  // Missing file -> null, never an exception.
  CHECK(!qntx::kernelFileRead(dir).has_value(), "file: missing must read null");

  // CAS on an absent file: a present expectation writes nothing.
  const std::vector<uint8_t> empty;
  const std::vector<uint8_t> first = {1, 2, 3};
  CHECK(
      !qntx::kernelFileReplace(dir, first.data(), first.size(), first),
      "file: absent file must not accept an expected image");
  CHECK(!qntx::kernelFileRead(dir).has_value(), "file: rejected CAS left a file behind");
  CHECK(
      qntx::kernelFileReplace(dir, empty.data(), empty.size(), std::nullopt),
      "file: create with absent expectation");
  const auto back = qntx::kernelFileRead(dir);
  CHECK(back.has_value() && back->empty(), "file: zero-length write");

  // Matching expectation swaps; stale expectation writes nothing.
  const std::vector<uint8_t> second = {9, 8, 7, 6, 5};
  CHECK(
      qntx::kernelFileReplace(dir, first.data(), first.size(), empty),
      "file: first write");
  CHECK(qntx::kernelFileRead(dir) == first, "file: first write read-back");
  CHECK(
      qntx::kernelFileReplace(dir, second.data(), second.size(), first),
      "file: atomic replace");
  CHECK(qntx::kernelFileRead(dir) == second, "file: atomic replace read-back");
  CHECK(
      !qntx::kernelFileReplace(dir, first.data(), first.size(), first),
      "file: stale expected must not write");
  CHECK(qntx::kernelFileRead(dir) == second, "file: lost CAS leaves file untouched");
  CHECK(
      !qntx::kernelFileReplace(dir, first.data(), first.size(), std::nullopt),
      "file: absent expectation on an existing file must not write");

  // Writers racing the same expected image: exactly one wins.
  std::atomic<int> wins{0};
  {
    std::vector<std::thread> racers;
    racers.reserve(8);
    for (int i = 0; i < 8; i++) {
      racers.emplace_back([&wins, &dir, &second, i] {
        const std::vector<uint8_t> candidate = {static_cast<uint8_t>(100 + i)};
        if (qntx::kernelFileReplace(dir, candidate.data(), candidate.size(), second)) {
          wins.fetch_add(1, std::memory_order_relaxed);
        }
      });
    }
    for (auto& racer : racers) {
      racer.join();
    }
  }
  CHECK(wins.load(std::memory_order_relaxed) == 1, "file: racing writers must produce one winner");
  const auto winner = qntx::kernelFileRead(dir);
  CHECK(
      winner.has_value() && winner->size() == 1 && winner->front() >= 100 &&
          winner->front() < 108,
      "file: the winning writer's bytes were committed");

  // Simulated crash mid-write: a stale .tmp never shadows the committed file.
  const std::string tmpPath = dir + "/vault.cbor.tmp";
  {
    FILE* f = std::fopen(tmpPath.c_str(), "wb");
    CHECK(f != nullptr, "file: open stale tmp");
    std::fputs("partial-garbage", f);
    std::fclose(f);
  }
  CHECK(qntx::kernelFileRead(dir) == winner, "file: crash mid-write preserves old file");

  return g_failures;
}

// The process-wide kernel slot: one live runtime at a time. A second claim
// while the first is live throws; a claim released with a still-stopping
// runtime hands it to the next claim as its predecessor, and the successor's
// beforeEvaluate-style wait returns only once that predecessor has stopped.
int kernelSlot() {
  qntx::KernelSlot slot;
  {
    auto claimA = slot.claim();
    CHECK(claimA.predecessor() == nullptr, "kernel-slot: fresh claim saw a predecessor");
    bool threw = false;
    try {
      (void)slot.claim();
    } catch (const std::runtime_error&) {
      threw = true;
    }
    CHECK(threw, "kernel-slot: second admission while live must throw");

    // A busy-loop runtime destroyed mid-run is still tearing down when the
    // claim releases it: the next claim inherits it as predecessor.
    Mailbox box1;
    auto rt1 =
        qntx::KernelRuntime::start(sourceScript("while (true) {}"), hooksFor(box1), "");
    rt1->destroy();
    CHECK(rt1->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
    claimA.release(rt1);

    auto claimB = slot.claim();
    CHECK(claimB.predecessor() == rt1, "kernel-slot: successor must inherit the predecessor");

    // The gate a successor wires into Hooks.beforeEvaluate: it returns only
    // after the predecessor stopped — it never gives up into an overlap.
    Mailbox box2;
    auto hooks2 = hooksFor(box2);
    hooks2.beforeEvaluate = [rt1](jsi::Runtime&) {
      while (!rt1->waitUntilStopped(std::chrono::seconds(1))) {
      }
    };
    const std::string js2 = std::string(kSendHelper) + R"JS(
__send("ready");
)JS";
    auto rt2 = qntx::KernelRuntime::start(sourceScript(js2), hooks2, "");
    CHECK(
        box2.waitPosts(1, std::chrono::seconds(30)),
        "kernel-slot: successor never evaluated");
    {
      std::lock_guard<std::mutex> lock(box2.m);
      CHECK(
          !box2.posts.empty() && box2.posts[0] == "ready" && box2.errors.empty(),
          "kernel-slot: successor crashed instead of waiting");
    }
    CHECK(
        rt1->waitUntilStopped(std::chrono::milliseconds(0)),
        "kernel-slot: predecessor still stopping when the successor evaluated");
    rt2->destroy();
    CHECK(
        rt2->waitUntilStopped(std::chrono::seconds(5)),
        "kernel-slot: successor runtime still running");
    claimB.release(rt2);
  }

  // Admission after release works: the handed-over runtime has stopped, so a
  // successor's wait returns immediately; a clean release leaves nothing.
  {
    auto claimC = slot.claim();
    CHECK(claimC.predecessor() != nullptr, "kernel-slot: stopping runtime must be handed over");
    CHECK(
        claimC.predecessor()->waitUntilStopped(std::chrono::milliseconds(0)),
        "kernel-slot: stopped predecessor must not block a successor");
    claimC.release(nullptr);
    auto claimD = slot.claim();
    CHECK(claimD.predecessor() == nullptr, "kernel-slot: clean release must leave no predecessor");
    claimD.release(nullptr);
  }
  return g_failures;
}

// A beforeEvaluate hook captures the still-stopping predecessor so the new
// kernel never overlaps the old vault writer. Stored on the Impl, that
// capture — and the Impl's copy of the script — must be released when the
// runtime stops: a live Impl otherwise keeps its predecessor's Impl, whose
// own hook keeps the one before, chaining every runtime ever started (each
// holding a full kernel image). The hook only waits, exactly like the host's
// gate; releasing the stored capture is teardown's job.
int predecessorChainReleased() {
  Mailbox box;
  const KernelScript script =
      sourceScript(std::string(kSendHelper) + "__send(\"ready\");");
  std::vector<std::weak_ptr<KernelRuntime>> runtimes;
  std::shared_ptr<KernelRuntime> previous;
  for (int i = 0; i < 4; i++) {
    auto hooks = hooksFor(box);
    hooks.beforeEvaluate = [previous](jsi::Runtime&) {
      if (previous != nullptr) {
        while (!previous->waitUntilStopped(std::chrono::seconds(1))) {
        }
      }
    };
    auto rt = KernelRuntime::start(script, hooks, "");
    runtimes.push_back(rt);
    CHECK(
        box.waitPosts(runtimes.size(), std::chrono::seconds(30)),
        "predecessor-chain: a runtime never evaluated");
    rt->destroy();
    CHECK(
        rt->waitUntilStopped(std::chrono::seconds(5)),
        "predecessor-chain: runtime still running after destroy");
    previous = std::move(rt);
  }
  const auto last = std::move(previous);
  // The locals are gone: only the chain itself could still hold runtimes 0..2.
  for (size_t i = 0; i + 1 < runtimes.size(); i++) {
    CHECK(
        runtimes[i].expired(),
        "predecessor-chain: a stopped runtime stayed reachable through the chain");
  }
  CHECK(
      last != nullptr && !runtimes.back().expired(),
      "predecessor-chain: the last runtime died while still referenced");
  CHECK(
      script.bytes.use_count() == 1,
      "predecessor-chain: teardown did not release the script bytes");
  return g_failures;
}

// The __qntx.file JS contract, exercised inside the real runtime: undefined on
// a missing file, replace accepts a TypedArray view (a subarray with non-zero
// byteOffset persists exactly those bytes) and returns whether the
// compare-and-swap won, a stale or absent expectation writes nothing, non-byte
// inputs throw for either argument, and a second runtime on the same
// directory reads the persisted bytes back.
int fileContract() {
  const std::string dir = makeTempDir();
  if (dir.empty()) {
    return g_failures;
  }
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
var out = [];
out.push("read:" + (__qntx.file.read() === undefined ? "undefined" : "not-undefined"));
var view = new Uint8Array([9, 1, 2, 3, 4, 8]).subarray(1, 5);
out.push("create:" + __qntx.file.replace(view));
var back = __qntx.file.read();
out.push("back:" + (back === undefined ? "undefined" : Array.from(back).join(",")));
out.push("swap:" + __qntx.file.replace(new Uint8Array([5, 6]), back));
out.push("stale:" + __qntx.file.replace(new Uint8Array([7]), view));
try {
  __qntx.file.replace({ length: 4 });
  out.push("object:no-throw");
} catch (e) {
  out.push("object:threw");
}
try {
  __qntx.file.replace("bytes");
  out.push("string:no-throw");
} catch (e) {
  out.push("string:threw");
}
try {
  __qntx.file.replace(new Uint8Array(1), "nope");
  out.push("expected:no-throw");
} catch (e) {
  out.push("expected:threw");
}
__send(out.join("|"));
)JS";
  {
    auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), dir);
    CHECK(box.waitPosts(1, std::chrono::seconds(30)), "file-contract: no report");
    rt->destroy();
    CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  }
  std::string report;
  {
    std::lock_guard<std::mutex> lock(box.m);
    if (!box.posts.empty()) {
      report = box.posts[0];
    }
  }
  CHECK(report.find("read:undefined") != std::string::npos, "file-contract: missing file must read undefined");
  CHECK(report.find("create:true") != std::string::npos, "file-contract: absent-expected create must win");
  CHECK(report.find("back:1,2,3,4") != std::string::npos,
      "file-contract: subarray bytes must persist exactly");
  CHECK(report.find("swap:true") != std::string::npos, "file-contract: matching-expected swap must win");
  CHECK(report.find("stale:false") != std::string::npos, "file-contract: stale expected must lose");
  CHECK(report.find("object:threw") != std::string::npos, "file-contract: plain object must throw");
  CHECK(report.find("string:threw") != std::string::npos, "file-contract: string must throw");
  CHECK(report.find("expected:threw") != std::string::npos, "file-contract: non-byte expected must throw");

  Mailbox box2;
  const std::string js2 = std::string(kSendHelper) + R"JS(
var back = __qntx.file.read();
__send(back === undefined ? "r:undefined" : "r:" + Array.from(back).join(","));
)JS";
  {
    auto rt2 = KernelRuntime::start(sourceScript(js2), hooksFor(box2), dir);
    CHECK(box2.waitPosts(1, std::chrono::seconds(30)), "file-contract: reload no report");
    rt2->destroy();
    CHECK(rt2->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  }
  {
    std::lock_guard<std::mutex> lock(box2.m);
    CHECK(!box2.posts.empty() && box2.posts[0] == "r:5,6",
        "file-contract: second runtime must read persisted bytes");
  }
  return g_failures;
}

// The __qntx.anchor JS contract, exercised inside the real runtime: undefined
// on an empty anchor, replace stores when expected is absent, a stale
// expectation writes nothing, the returned bytes are a copy (mutating them
// does not corrupt the stored record), non-byte inputs throw, a second
// runtime reads the same record back, and a scripted platform failure
// surfaces as a JS throw on either entry point.
int anchorContract() {
  qntxTestAnchor::reset();
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
var out = [];
out.push("read:" + (__qntx.anchor.read() === undefined ? "undefined" : "not-undefined"));
var view = new Uint8Array([9, 1, 2, 3, 4, 8]).subarray(1, 5);
out.push("create:" + __qntx.anchor.replace(view));
var back = __qntx.anchor.read();
out.push("back:" + (back === undefined ? "undefined" : Array.from(back).join(",")));
back[0] = 77;
var again = __qntx.anchor.read();
out.push("copy:" + (again[0] === 1 ? "isolated" : "aliased"));
out.push("swap:" + __qntx.anchor.replace(new Uint8Array([5, 6]), again));
out.push("stale:" + __qntx.anchor.replace(new Uint8Array([7]), view));
try {
  __qntx.anchor.replace({ length: 4 });
  out.push("object:no-throw");
} catch (e) {
  out.push("object:threw");
}
try {
  __qntx.anchor.replace("bytes");
  out.push("string:no-throw");
} catch (e) {
  out.push("string:threw");
}
try {
  __qntx.anchor.replace(new Uint8Array(1), "nope");
  out.push("expected:no-throw");
} catch (e) {
  out.push("expected:threw");
}
__send(out.join("|"));
)JS";
  {
    auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
    CHECK(box.waitPosts(1, std::chrono::seconds(30)), "anchor-contract: no report");
    rt->destroy();
    CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  }
  std::string report;
  {
    std::lock_guard<std::mutex> lock(box.m);
    if (!box.posts.empty()) {
      report = box.posts[0];
    }
  }
  CHECK(report.find("read:undefined") != std::string::npos, "anchor-contract: empty anchor must read undefined");
  CHECK(report.find("create:true") != std::string::npos, "anchor-contract: absent-expected create must win");
  CHECK(report.find("back:1,2,3,4") != std::string::npos,
      "anchor-contract: subarray bytes must persist exactly");
  CHECK(report.find("copy:isolated") != std::string::npos,
      "anchor-contract: read must return a copy, not stored bytes");
  CHECK(report.find("swap:true") != std::string::npos, "anchor-contract: matching-expected swap must win");
  CHECK(report.find("stale:false") != std::string::npos, "anchor-contract: stale expected must lose");
  CHECK(qntxTestAnchor::stored() == std::optional<std::vector<uint8_t>>({5, 6}),
      "anchor-contract: a lost CAS must leave the record untouched");
  CHECK(report.find("object:threw") != std::string::npos, "anchor-contract: plain object must throw");
  CHECK(report.find("string:threw") != std::string::npos, "anchor-contract: string must throw");
  CHECK(report.find("expected:threw") != std::string::npos, "anchor-contract: non-byte expected must throw");

  // A second runtime sees the same anchor — the record lives in the platform,
  // not in the runtime.
  Mailbox box2;
  const std::string js2 = std::string(kSendHelper) + R"JS(
var back = __qntx.anchor.read();
__send(back === undefined ? "r:undefined" : "r:" + Array.from(back).join(","));
)JS";
  {
    auto rt2 = KernelRuntime::start(sourceScript(js2), hooksFor(box2), "");
    CHECK(box2.waitPosts(1, std::chrono::seconds(30)), "anchor-contract: reload no report");
    rt2->destroy();
    CHECK(rt2->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  }
  {
    std::lock_guard<std::mutex> lock(box2.m);
    CHECK(!box2.posts.empty() && box2.posts[0] == "r:5,6",
        "anchor-contract: second runtime must read the same record");
  }

  // A platform failure surfaces as a JS throw on both entry points.
  qntxTestAnchor::failAll();
  Mailbox box3;
  const std::string js3 = std::string(kSendHelper) + R"JS(
var out = [];
try {
  __qntx.anchor.read();
  out.push("read:no-throw");
} catch (e) {
  out.push("read:threw");
}
try {
  __qntx.anchor.replace(new Uint8Array(1));
  out.push("replace:no-throw");
} catch (e) {
  out.push("replace:threw");
}
__send(out.join("|"));
)JS";
  {
    auto rt3 = KernelRuntime::start(sourceScript(js3), hooksFor(box3), "");
    CHECK(box3.waitPosts(1, std::chrono::seconds(30)), "anchor-contract: failure case no report");
    rt3->destroy();
    CHECK(rt3->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  }
  {
    std::lock_guard<std::mutex> lock(box3.m);
    CHECK(!box3.posts.empty() &&
              box3.posts[0].find("read:threw") != std::string::npos &&
              box3.posts[0].find("replace:threw") != std::string::npos,
        "anchor-contract: a platform failure must surface as a JS throw");
  }
  return g_failures;
}

int queueCap() {
  Mailbox box;
  bool integrity = false;
  auto hooks = hooksFor(box);
  hooks.onIntegrity = [&] {
    std::lock_guard<std::mutex> lock(box.m);
    integrity = true;
    box.cv.notify_all();
  };
  auto rt = KernelRuntime::start(
      sourceScript(
          std::string(kSendHelper) +
          // Keep the kernel thread busy after ready so the 70 inbound frames pile
          // up in the queue instead of draining instantly.
          "__send(\"ready\"); var t = Date.now(); while (Date.now() - t < 5000) {}"),
      std::move(hooks), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(30)), "queue-cap: no ready");
  std::vector<uint8_t> frame(16, 0x61);
  for (int i = 0; i < 70; i++) {
    rt->post(qntx::SecretBytes(frame.data(), frame.size()));
  }
  {
    std::unique_lock<std::mutex> lock(box.m);
    box.cv.wait_for(lock, std::chrono::seconds(10), [&] { return integrity; });
    CHECK(integrity, "queue-cap: 65+ frames did not fire integrity");
  }
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  return g_failures;
}

int globalInventory(KernelProfile profile) {
  Mailbox box;
  auto rt = KernelRuntime::start(
      sourceScript(
          std::string(kSendHelper) +
          "__send(JSON.stringify(Object.getOwnPropertyNames(globalThis)));"),
      hooksFor(box),
      "",
      profile);
  CHECK(box.waitPosts(1, std::chrono::seconds(30)), "inventory: no report");
  std::set<std::string> kernelNames;
  {
    std::lock_guard<std::mutex> lock(box.m);
    if (!box.posts.empty()) {
      const std::string& json = box.posts[0];
      size_t i = 0;
      while (i < json.size()) {
        auto begin = json.find('"', i);
        if (begin == std::string::npos) {
          break;
        }
        auto end = json.find('"', begin + 1);
        if (end == std::string::npos) {
          break;
        }
        kernelNames.insert(json.substr(begin + 1, end - begin - 1));
        i = end + 1;
      }
    }
  }
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  // __send is declared by the test script itself, not installed by the runtime.
  kernelNames.erase("__send");
  auto bare = facebook::hermes::makeHermesRuntime(bareConfig(profile));
  std::set<std::string> bareNames = globalNames(*bare);
  std::vector<std::string> diff;
  for (const auto& name : kernelNames) {
    if (bareNames.find(name) == bareNames.end()) {
      diff.push_back(name);
    }
  }
  // Hermes 260318099+ (RN 0.88) ships a native TextDecoder, so it is part of
  // the bare set; the kernel only freezes it and rebinds it hidden, which keeps
  // the name out of this diff.
  const std::set<std::string> expected =
      {"__qntx", "crypto", "setTimeout", "clearTimeout"};
  CHECK(
      std::set<std::string>(diff.begin(), diff.end()) == expected,
      "inventory: unexpected kernel global set");
  if (g_failures > 0) {
    std::fprintf(stderr, "inventory diff:");
    for (const auto& name : diff) {
      std::fprintf(stderr, " %s", name.c_str());
    }
    std::fprintf(stderr, "\n");
  }
  return g_failures;
}

int textDecoderCase() {
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
var out = [];
function t(name, f) {
  try { out.push(name + ":" + f()); } catch (e) { out.push(name + ":" + e.name); }
}
function dec(bytes, opts) {
  return new TextDecoder("utf-8", opts).decode(new Uint8Array(bytes), opts);
}
// Valid 1-4 byte sequences (code points — the post channel is ASCII only).
out.push("ascii:" + dec([0x61]));
out.push("two:" + dec([0xc3, 0xa9]).charCodeAt(0));
out.push("three:" + dec([0xe2, 0x82, 0xac]).charCodeAt(0));
out.push("four:" + dec([0xf0, 0x9f, 0x98, 0x80]).length);
// BOM strip by default, kept under ignoreBOM.
out.push("bom:" + dec([0xef, 0xbb, 0xbf, 0x78]));
out.push("bomKeep:" + dec([0xef, 0xbb, 0xbf, 0x78], { ignoreBOM: true }).length);
// fatal rejects.
var bad = [
  [0xc0, 0x80], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80],
  [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82], [0x80],
];
for (var i = 0; i < bad.length; i++) {
  (function (bytes, idx) {
    t("fatal" + idx, function () {
      dec(bytes, { fatal: true });
      return "ran";
    });
  })(bad[i], i);
}
// WHATWG maximal-subpart replacement counts.
out.push("repTrunc4:" + dec([0xf0, 0x90, 0x80]).length);
out.push("repC0:" + dec([0xc0, 0x80]).length);
out.push("repED:" + dec([0xed, 0xa0, 0x80]).length);
// The native decoder supports streaming; a split multibyte sequence must join
// across calls instead of throwing or replacing.
out.push("stream:" + (function () {
  var d = new TextDecoder();
  var a = d.decode(new Uint8Array([0xe2, 0x82]), { stream: true });
  var b = d.decode(new Uint8Array([0xac]));
  return a.length === 0 && b.charCodeAt(0) === 0x20ac ? "ok" : "bad";
})());
t("label", function () {
  new TextDecoder("not-a-real-encoding");
  return "ran";
});
t("labels", function () {
  new TextDecoder(" UTF8 ");
  new TextDecoder("unicode-1-1-utf-8");
  return "ok";
});
out.push("empty:" + (new TextDecoder().decode() === ""));
__send(out.join(","));
)JS";
  auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(30)), "decoder: no report");
  std::lock_guard<std::mutex> lock(box.m);
  if (!box.posts.empty()) {
    const std::string& r = box.posts[0];
    CHECK(r.find("ascii:a") != std::string::npos &&
              r.find("two:233") != std::string::npos &&
              r.find("three:8364") != std::string::npos &&
              r.find("four:2") != std::string::npos,
        "decoder: valid sequences failed");
    CHECK(r.find("bom:x") != std::string::npos &&
              r.find("bomKeep:2") != std::string::npos,
        "decoder: BOM handling wrong");
    for (int i = 0; i < 6; i++) {
      CHECK(r.find("fatal" + std::to_string(i) + ":TypeError") != std::string::npos,
          ("decoder: fatal accepted bad input " + std::to_string(i)).c_str());
    }
    CHECK(r.find("repTrunc4:1") != std::string::npos &&
              r.find("repC0:2") != std::string::npos &&
              r.find("repED:3") != std::string::npos,
        "decoder: replacement counts wrong");
    CHECK(r.find("stream:ok") != std::string::npos,
        "decoder: streaming decode broken");
    CHECK(r.find("label:RangeError") != std::string::npos,
        "decoder: unknown label did not throw RangeError");
    CHECK(r.find("labels:ok") != std::string::npos &&
              r.find("empty:true") != std::string::npos,
        "decoder: valid labels or empty decode failed");
  }
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  return g_failures;
}

int pbkdf2Vectors() {
  const char* expect1 = std::getenv("V1_PBKDF2_SHA256_1");
  const char* expect2 = std::getenv("V1_PBKDF2_SHA256_80000");
  const char* expect3 = std::getenv("V1_PBKDF2_SHA512_UTF8");
  CHECK(expect1 && expect2 && expect3, "pbkdf2: expected vectors not in env");
  Mailbox box;
  // Password/salt byte lists are UTF-8 encodings baked in by the script.
  const std::string js = std::string(kSendHelper) + R"JS(
var pending = 3;
var out = [];
function hex(b) {
  var h = "";
  for (var i = 0; i < b.length; i++) {
    var x = b[i].toString(16);
    h += x.length < 2 ? "0" + x : x;
  }
  return h;
}
function ascii(s) {
  var a = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) { a[i] = s.charCodeAt(i); }
  return a;
}
function done(r, e) {
  out.push(e ? "err" : hex(r));
  if (--pending === 0) { __send(out.join(",")); }
}
__qntx.pbkdf2("sha256", ascii("passwd"), ascii("salt"), 1, 64, done);
__qntx.pbkdf2("sha256", ascii("Password"), ascii("NaCl"), 80000, 64, done);
__qntx.pbkdf2("sha512", new Uint8Array([
  0x70, 0xc3, 0xa4, 0x73, 0x73, 0x77, 0xc3, 0xb6, 0x72, 0x64, 0x20, 0xf0, 0x9f, 0x94, 0x91]),
  new Uint8Array([0x73, 0x61, 0x6c, 0x74, 0x2d, 0xe2, 0x9c, 0x93]), 777, 48, done);
)JS";
  auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(60)), "pbkdf2: no report");
  {
    std::lock_guard<std::mutex> lock(box.m);
    if (!box.posts.empty() && expect1 && expect2 && expect3) {
      const std::string want =
          std::string(expect1) + "," + expect2 + "," + expect3;
      CHECK(box.posts[0] == want, "pbkdf2: vector mismatch");
      if (box.posts[0] != want) {
        std::fprintf(stderr, "pbkdf2 got:  %s\nwant: %s\n", box.posts[0].c_str(), want.c_str());
      }
    }
  }
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  return g_failures;
}

// The reference implementation behind __qntx.argon2id against node:crypto's
// Argon2id: the backup password's cost, and a small case with one lane.
int argon2idVectors() {
  const char* expectBackup = std::getenv("V1_ARGON2ID_BACKUP");
  const char* expectSmall = std::getenv("V1_ARGON2ID_SMALL");
  CHECK(expectBackup && expectSmall, "argon2id: expected vectors not in env");
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
var pending = 2;
var out = ["", ""];
function hex(b) {
  var h = "";
  for (var i = 0; i < b.length; i++) {
    var x = b[i].toString(16);
    h += x.length < 2 ? "0" + x : x;
  }
  return h;
}
function ascii(s) {
  var a = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) { a[i] = s.charCodeAt(i); }
  return a;
}
function done(slot) {
  return function (r, e) {
    out[slot] = e ? "err:" + e : hex(r);
    if (--pending === 0) { __send(out.join(",")); }
  };
}
var rejected = [];
function refuses(name, call) {
  try { call(); rejected.push(name + ":accepted"); } catch (e) { rejected.push(name + ":threw"); }
}
refuses("memory", function () {
  __qntx.argon2id(ascii("p"), ascii("saltsalt"), 4, 1, 1, 32, function () {});
});
refuses("lanes", function () {
  __qntx.argon2id(ascii("p"), ascii("saltsalt"), 64, 1, 0, 32, function () {});
});
refuses("length", function () {
  __qntx.argon2id(ascii("p"), ascii("saltsalt"), 64, 1, 1, 2, function () {});
});
__send(rejected.join(","));
__qntx.argon2id(ascii("backup vector password"), ascii("0123456789abcdef"), 65536, 3, 4, 32, done(0));
__qntx.argon2id(ascii("password"), ascii("somesalt"), 64, 2, 1, 24, done(1));
)JS";
  auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
  CHECK(box.waitPosts(2, std::chrono::seconds(180)), "argon2id: no report");
  {
    std::lock_guard<std::mutex> lock(box.m);
    if (box.posts.size() == 2 && expectBackup && expectSmall) {
      CHECK(box.posts[0] == "memory:threw,lanes:threw,length:threw",
          "argon2id: an out-of-range cost was accepted");
      const std::string want = std::string(expectBackup) + "," + expectSmall;
      CHECK(box.posts[1] == want, "argon2id: vector mismatch");
      if (box.posts[1] != want) {
        std::fprintf(stderr, "argon2id got:  %s\nwant: %s\n", box.posts[1].c_str(), want.c_str());
      }
    }
  }
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  CHECK(box.errors.empty(), "argon2id: unexpected onError");
  return g_failures;
}

int kdfQueueFull() {
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
var errors = [];
var done = 0;
function cb(r, e) {
  done += 1;
  if (e) { errors.push(e); }
  if (errors.length > 0) {
    __send("error:" + errors[0]);
  }
}
// Occupy the single worker for seconds, then fill the queue of 8: the ninth
// queued job must come back with "kdf queue full".
__qntx.pbkdf2("sha256", new Uint8Array(4), new Uint8Array(4), 10000000, 32, cb);
for (var i = 0; i < 8; i++) {
  __qntx.pbkdf2("sha256", new Uint8Array(4), new Uint8Array(4), 1, 32, cb);
}
__qntx.pbkdf2("sha256", new Uint8Array(4), new Uint8Array(4), 1, 32, cb);
)JS";
  auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
  // Both the ninth and the tenth submit can be rejected when the worker has
  // not picked up the first job yet; every rejection must carry the error.
  CHECK(
      box.waitPosts(1, std::chrono::seconds(30)),
      "kdf-queue: full-queue error never arrived");
  {
    std::lock_guard<std::mutex> lock(box.m);
    for (const auto& post : box.posts) {
      CHECK(post == "error:kdf queue full", "kdf-queue: wrong error string");
    }
    CHECK(box.errors.empty(), "kdf-queue: unexpected onError");
  }
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  return g_failures;
}

int elapsedMonotonic() {
  Mailbox box;
  const std::string js = std::string(kSendHelper) + R"JS(
var prev = __qntx.elapsed();
var monotonic = true;
var fractional = prev !== Math.floor(prev);
var subMs = false;
for (var i = 0; i < 1000; i++) {
  var t = __qntx.elapsed();
  if (t < prev) { monotonic = false; }
  if (t - prev > 0 && t - prev < 1) { subMs = true; }
  if (t !== Math.floor(t)) { fractional = true; }
  prev = t;
}
__send("monotonic:" + monotonic + ",fractional:" + fractional + ",subMs:" + subMs);
)JS";
  auto rt = KernelRuntime::start(sourceScript(js), hooksFor(box), "");
  CHECK(box.waitPosts(1, std::chrono::seconds(30)), "elapsed: no report");
  std::lock_guard<std::mutex> lock(box.m);
  CHECK(!box.posts.empty() &&
            box.posts[0].find("monotonic:true") != std::string::npos &&
            box.posts[0].find("fractional:true") != std::string::npos &&
            box.posts[0].find("subMs:true") != std::string::npos,
      "elapsed: not monotonic or no sub-ms resolution");
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  return g_failures;
}

int kernelProbe(bool bytecode, KernelProfile profile) {
  Mailbox box;
  auto rt = KernelRuntime::start(
      probeScript(qntx::harness::probes::kKernel, bytecode), hooksFor(box), "", profile);
  CHECK(
      box.waitPosts(2, std::chrono::seconds(180)),
      "kernel-probe: expected kernel-ready and done posts");
  {
    std::lock_guard<std::mutex> lock(box.m);
    if (box.posts.size() >= 2) {
      CHECK(box.posts[0].find("\"kernel-ready\"") != std::string::npos,
          "kernel-probe: first post was not kernel-ready");
      CHECK(box.posts[1].find("\"pass\":true") != std::string::npos,
          "kernel-probe: kernel probe failed");
      if (box.posts[1].find("\"pass\":true") == std::string::npos) {
        std::fprintf(stderr, "kernel-probe result: %s\n", box.posts[1].c_str());
      }
    }
  }
  CHECK(box.errors.empty(), "kernel-probe: unexpected onError");
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  return g_failures;
}

// Regression check for the measured timer-globals decision: Promise.then and
// async/await ride the engine microtask queue and need no globals; the
// bundled rejection tracker defers onUnhandled through the literal
// setTimeout/clearTimeout globals the prelude installs. This case re-arms the
// tracker with a posting callback and asserts the installed globals actually
// deliver it.
int measureTimers(KernelProfile profile) {
  Mailbox box;
  auto rt = KernelRuntime::start(
      sourceScript(std::string(kSendHelper) + R"JS(
Promise.resolve().then(function () { __send("then-ok"); });
(async function () { await Promise.resolve(); __send("async-ok"); })();
HermesInternal.enablePromiseRejectionTracker({
  allRejections: true,
  onUnhandled: function (id, e) { __send("unhandled"); },
  onHandled: function (id) { __send("handled"); }
});
Promise.reject(new TypeError("rejection probe"));
)JS"),
      hooksFor(box),
      "",
      profile);
  box.waitPosts(3, std::chrono::seconds(10));
  rt->destroy();
  CHECK(rt->waitUntilStopped(std::chrono::seconds(5)), "runtime still running after destroy");
  std::lock_guard<std::mutex> lock(box.m);
  bool thenOk = false;
  bool asyncOk = false;
  bool unhandled = false;
  for (const auto& p : box.posts) {
    thenOk = thenOk || p == "then-ok";
    asyncOk = asyncOk || p == "async-ok";
    unhandled = unhandled || p == "unhandled";
  }
  CHECK(thenOk, "measure: Promise.then did not run");
  CHECK(asyncOk, "measure: async function did not run");
  CHECK(unhandled, "measure: rejection tracker never fired via setTimeout");
  CHECK(box.errors.empty(), "measure: unexpected onError");
  return g_failures;
}

} // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: RuntimeHostTest <case> [bytecode.hbc]\n");
    return 2;
  }
  const std::string testCase = argv[1];
  const char* hbcPath = argc > 2 ? argv[2] : nullptr;

  using Entry = std::function<int(const char* hbc)>;
  const Entry needHbc = [&testCase](const char*) -> int {
    std::fprintf(stderr, "%s needs a .hbc path\n", testCase.c_str());
    return 2;
  };
  const std::map<std::string, Entry> cases = {
      {"destroy-busyloop-source", [](const char*) { return destroyBusyloop(nullptr); }},
      {"destroy-busyloop-bytecode",
       [&needHbc](const char* hbc) {
         return hbc == nullptr ? needHbc(hbc) : destroyBusyloop(hbc);
       }},
      {"destroy-before-evaluate", [](const char*) { return destroyBeforeEvaluate(); }},
      {"destroy-during-before-evaluate",
       [](const char*) { return destroyDuringBeforeEvaluate(); }},
      {"destroy-concurrent", [](const char*) { return destroyConcurrent(); }},
      {"destroy-kdf-inflight", [](const char*) { return destroyKdfInflight(); }},
      {"timers-cancel", [](const char*) { return timersCancel(); }},
      {"timers-fired", [](const char*) { return timersFired(); }},
      {"forged-views", [](const char*) { return forgedViews(); }},
      {"numeric-validation", [](const char*) { return numericValidation(); }},
      {"random-bounds", [](const char*) { return randomBounds(); }},
      {"getrandomvalues", [](const char*) { return getRandomValuesCase(); }},
      {"crash-sync-source", [](const char*) { return crashCase(false, false); }},
      {"crash-sync-bytecode", [](const char*) { return crashCase(false, true); }},
      {"crash-promise-source", [](const char*) { return crashCase(true, false); }},
      {"crash-promise-bytecode", [](const char*) { return crashCase(true, true); }},
      {"eval-disabled-standard",
       [](const char*) { return evalDisabled(KernelProfile::standard); }},
      {"eval-disabled-hardened",
       [](const char*) { return evalDisabled(KernelProfile::hardened); }},
      {"global-descriptors", [](const char*) { return globalDescriptors(); }},
      {"global-inventory-standard",
       [](const char*) { return globalInventory(KernelProfile::standard); }},
      {"global-inventory-hardened",
       [](const char*) { return globalInventory(KernelProfile::hardened); }},
      {"textdecoder", [](const char*) { return textDecoderCase(); }},
      {"pbkdf2-vectors", [](const char*) { return pbkdf2Vectors(); }},
      {"argon2id-vectors", [](const char*) { return argon2idVectors(); }},
      {"kdf-queue-full", [](const char*) { return kdfQueueFull(); }},
      {"elapsed-monotonic", [](const char*) { return elapsedMonotonic(); }},
      {"kernel-probe-source-standard",
       [](const char*) { return kernelProbe(false, KernelProfile::standard); }},
      {"kernel-probe-bytecode-standard",
       [](const char*) { return kernelProbe(true, KernelProfile::standard); }},
      {"kernel-probe-source-hardened",
       [](const char*) { return kernelProbe(false, KernelProfile::hardened); }},
      {"kernel-probe-bytecode-hardened",
       [](const char*) { return kernelProbe(true, KernelProfile::hardened); }},
      {"lifecycle-boundaries",
       [](const char*) { return lifecycleBoundaries(); }},
      {"lifecycle-dispatcher",
       [](const char*) { return lifecycleDispatcher(); }},
      {"kernel-bytecode", [](const char*) { return kernelBytecode(); }},
      {"qntx-globals", [](const char*) { return qntxGlobals(); }},
      {"keystore-binding", [](const char*) { return keystoreBinding(); }},
      {"keystore-teardown", [](const char*) { return keystoreTeardown(); }},
      {"passkey-binding", [](const char*) { return passkeyBinding(); }},
      {"card-reader-binding", [](const char*) { return cardReaderBinding(); }},
      {"card-reader-busy", [](const char*) { return cardReaderBusy(); }},
      {"card-reader-teardown", [](const char*) { return cardReaderTeardown(); }},
      {"card-reader-stale", [](const char*) { return cardReaderStale(); }},
      {"secure-input-binding", [](const char*) { return secureInputBinding(); }},
      {"secure-input-teardown", [](const char*) { return secureInputTeardown(); }},
      {"secure-input-hub", [](const char*) { return secureInputHubCase(); }},
      {"backends-spark", [](const char*) { return backendsSpark(); }},
      {"backends-nostr", [](const char*) { return backendsNostr(); }},
      {"file-primitive", [](const char*) { return filePrimitive(); }},
      {"file-contract", [](const char*) { return fileContract(); }},
      {"anchor-contract", [](const char*) { return anchorContract(); }},
      {"kernel-slot", [](const char*) { return kernelSlot(); }},
      {"predecessor-chain", [](const char*) { return predecessorChainReleased(); }},
      {"queue-cap", [](const char*) { return queueCap(); }},
      {"measure-timers-standard",
       [](const char*) { return measureTimers(KernelProfile::standard); }},
      {"measure-timers-hardened",
       [](const char*) { return measureTimers(KernelProfile::hardened); }},
  };
  const auto found = cases.find(testCase);
  if (found == cases.end()) {
    if (testCase == "--list") {
      for (const auto& [name, _] : cases) {
        std::printf("%s\n", name.c_str());
      }
      return 0;
    }
    std::fprintf(stderr, "unknown case: %s\n", testCase.c_str());
    return 2;
  }
  return found->second(hbcPath);
}
