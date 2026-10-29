#pragma once

namespace qntxTestSpark {

// Buffers the fake qs_* emitted that are still outstanding — must be empty
// once the kernel has called qs_free for every output it received.
int outstandingAllocs();
// qs_free calls with an unknown pointer or a mismatched length.
int badFrees();
// Successful retirements through qs_free.
int goodFrees();

} // namespace qntxTestSpark
