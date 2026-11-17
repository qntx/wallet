# Argon2 reference implementation

The portable reference C implementation of Argon2 from
<https://github.com/P-H-C/phc-winner-argon2>, commit
`f57e61e19229e23c4445b85494dbf7c07de721cb` (2021-06-25), dual-licensed CC0 1.0 / Apache 2.0
(`LICENSE`). The files are byte-identical to that commit; only the subset the kernel runtime links
is vendored:

- `include/argon2.h`
- `src/argon2.c`, `src/core.{c,h}`, `src/ref.c`, `src/thread.{c,h}`, `src/encoding.{c,h}`
- `src/blake2/blake2b.c`, `src/blake2/{blake2,blake2-impl,blamka-round-ref}.h`

`src/opt.c` (the SSE/AVX build) is left out: `ref.c` is the same algorithm on every ABI the
package ships, and one code path is what the vectors in `vectors/backup.json` pin.

Neither iOS nor Android ships Argon2, and the pure-JS implementation the Web kernel uses is too
slow in Hermes, which has no JIT. `cpp/runtime/platform/KernelArgon2.cpp` is the only caller.

To update: copy the same files from a newer commit, change the commit above, and run
`bun run native:host-test` — it checks the reference vector under ASan, UBSan and TSan.
