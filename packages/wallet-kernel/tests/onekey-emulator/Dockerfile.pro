# OneKey Pro "core" (MicroPython) firmware emulator.
# Source: https://github.com/OneKeyHQ/firmware-pro @ v4.21.0
#         (251a1b762065357059f80f32b28cb502609510d3)
# Builds `make -C core build_unix` (SCons + cargo for embed/rust) and runs the
# resulting unix-port emulator headless.
#
#   main wire link : UDP 54935   (ONEKEY_UDP_PORT, offset +0)
#   debug link     : UDP 54936   (offset +1)
#   webauthn       : UDP 54937   (offset +2)
#   vcp/console    : UDP 54938   (offset +3, debug builds only)
#
# Build:  docker build -f Dockerfile.pro -t onekey-emu-pro .
# Run:    docker run --rm -p 54935:54935/udp -p 54936:54936/udp onekey-emu-pro
#
# python:3.10-slim-bookworm multi-arch index digest (amd64 + arm64).
FROM python:3.10-slim-bookworm@sha256:5be5aaecb962a41567bc8041f1e9e3432cb085b037fe057f9a562630b2e4b370 AS build

ARG PRO_COMMIT=251a1b762065357059f80f32b28cb502609510d3
ARG PROTOC_VERSION=3.19.5
# Optional Debian mirror host (e.g. mirrors.tuna.tsinghua.edu.cn) for hosts
# where deb.debian.org is slow. Empty keeps the default upstream mirror.
ARG APT_MIRROR=

RUN if [ -n "${APT_MIRROR}" ]; then \
        sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi && \
    apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        git \
        libclang-dev \
        libsdl2-dev \
        libsdl2-image-dev \
        pkg-config \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# protoc matching the pinned protobuf runtime (poetry.lock: protobuf==3.19.5).
RUN arch="$(dpkg --print-architecture)" && \
    case "$arch" in \
      amd64) protoc_arch="x86_64" ;; \
      arm64) protoc_arch="aarch_64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac && \
    curl -fsSL -o /tmp/protoc.zip \
      "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-${protoc_arch}.zip" && \
    unzip -o -q /tmp/protoc.zip -d /usr/local bin/protoc 'include/*' && \
    rm /tmp/protoc.zip

# Python packages needed by the build (SCons driver, pb2py codegen, mako
# templates, the trezor python package pulled by emu tooling), pinned to the
# firmware commit's poetry.lock and hash-checked — see requirements-pro.txt.
COPY requirements-pro.txt /tmp/requirements-pro.txt
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements-pro.txt

# Rust toolchain for embed/rust (cargo build, edition 2021 crates).
# RUSTUP_DIST_SERVER / RUSTUP_UPDATE_ROOT may be pointed at a mirror (e.g.
# https://mirrors.tuna.tsinghua.edu.cn/rustup) where static.rust-lang.org is
# slow; leave empty to use the official servers.
ARG RUSTUP_DIST_SERVER=
ARG RUSTUP_UPDATE_ROOT=
ENV RUSTUP_DIST_SERVER=${RUSTUP_DIST_SERVER:+${RUSTUP_DIST_SERVER}} \
    RUSTUP_UPDATE_ROOT=${RUSTUP_UPDATE_ROOT:+${RUSTUP_UPDATE_ROOT}}
RUN update_root="${RUSTUP_UPDATE_ROOT:-https://static.rust-lang.org/rustup}" && \
    arch="$(dpkg --print-architecture)" && \
    case "$arch" in \
      amd64) triple="x86_64-unknown-linux-gnu" ;; \
      arm64) triple="aarch64-unknown-linux-gnu" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac && \
    curl --retry 5 --retry-all-errors -fsSL -o /tmp/rustup-init \
      "${update_root}/dist/${triple}/rustup-init" && \
    chmod +x /tmp/rustup-init && \
    /tmp/rustup-init -y --profile minimal --default-toolchain stable && \
    rm /tmp/rustup-init
ENV PATH=/root/.cargo/bin:$PATH
# Optional crates.io registry mirror (e.g. https://mirrors.tuna.tsinghua.edu.cn/git/crates.io-index.git
# or a sparse index such as https://rsproxy.cn/index/config.json).
ARG CRATES_REGISTRY=
RUN if [ -n "${CRATES_REGISTRY}" ]; then \
        mkdir -p /root/.cargo && \
        printf '[source.crates-io]\nreplace-with = "mirror"\n[source.mirror]\nregistry = "%s"\n' \
            "${CRATES_REGISTRY}" > /root/.cargo/config.toml; \
    fi

# Optional local source fallback for networks that cannot sustain the GitHub
# pack download: drop a clone of the repo in the build context at
# vendor-src/firmware-pro (and submodule checkouts at vendor-src/modules/<name>)
# and it is used instead. Upstream remains the default.
COPY vendor-src/ /opt/vendor-src/
RUN git init /src && cd /src && \
    if [ -d /opt/vendor-src/firmware-pro/.git ]; then \
        REPO="file:///opt/vendor-src/firmware-pro"; \
    else \
        REPO="https://github.com/OneKeyHQ/firmware-pro.git"; \
    fi && \
    git remote add origin "${REPO}" && \
    git config http.postBuffer 524288000 && \
    git config http.version HTTP/1.1 && \
    ok=0 && \
    for try in 1 2 3; do \
        git fetch --depth 1 origin "${PRO_COMMIT}" && ok=1 && break; \
        sleep 10; \
    done; \
    [ "${ok}" = 1 ] || exit 1; \
    git checkout FETCH_HEAD && \
    for sub in vendor/micropython vendor/lvgl_mp vendor/secp256k1-zkp \
               vendor/QR-Code-generator common/defs/ethereum/chains; do \
        name="$(basename "${sub}")"; \
        if [ -d "/opt/vendor-src/modules/${name}" ]; then \
            cp -a "/opt/vendor-src/modules/${name}/." "${sub}/" && \
            rm -rf "${sub}/.git"; \
            continue; \
        fi; \
        rec=; \
        if [ "${sub}" = "vendor/lvgl_mp" ]; then rec="--recursive"; fi; \
        ok=0; \
        for try in 1 2 3; do \
            git submodule update --init ${rec} --depth 1 "${sub}" && ok=1 && break; \
            sleep 10; \
        done; \
        [ "${ok}" = 1 ] || exit 1; \
    done

# Emulator fixes on top of v4.21.0: unix-build compile bitrot, stubs for
# hardware absent in the emulator (THD89 secure element, fingerprint, motor,
# NFC, LCD), a keyed config store standing in for the SE regions (the int-tag
# scheme uses keys as logical tags, not byte offsets), DebugLink button/touch
# plumbing, zeroed report padding, and a larger MicroPython pystack for the
# locale table. See pro-emulator.patch for the per-file diff.
COPY pro-emulator.patch /tmp/pro-emulator.patch
RUN git -C /src apply -p1 /tmp/pro-emulator.patch

# PYOPT=0 keeps __debug__ code paths compiled in (debug link interface is
# enabled at runtime via `trezor-emu-core -O0`). embed/rust is a no_std
# crate gated on `#![feature(lang_items)]`, which needs nightly rustc — the
# project itself uses RUSTC_BOOTSTRAP to build it on stable (SConscript.unix
# does the same for the sanitizer profile).
RUN cd /src/core && RUSTC_BOOTSTRAP=1 PYOPT=0 make build_unix

# The LVGL font assets the unix emulator loads are Git LFS pointer files in
# the checkout; pull the real objects or the display driver crashes on a NULL
# font. The emulator loads the *-emu.bin variants plus the mono-38 keypad font
# (only built into hardware firmware, so the patch loads it from res/). Kept
# after the build so an asset-list change does not re-run the compile.
RUN for f in \
        Geist-Regular-20-emu.bin Geist-Regular-26-emu.bin Geist-Regular-30-emu.bin \
        Geist-SemiBold-26-emu.bin Geist-SemiBold-30-emu.bin Geist-SemiBold-38-emu.bin \
        Geist-SemiBold-48-emu.bin Geist-SemiBold-64-emu.bin GeistMono-Regular-28-emu.bin \
        GeistMono-SemiBold-38.bin; do \
        curl --retry 5 --retry-all-errors -fsSL -o \
            "/src/core/src/trezor/lvglui/res/${f}" \
            "https://github.com/OneKeyHQ/firmware-pro/raw/${PRO_COMMIT}/core/src/trezor/lvglui/res/${f}" || exit 1; \
        ! head -c 40 "/src/core/src/trezor/lvglui/res/${f}" | grep -q "git-lfs" || exit 1; \
    done

# ---------------------------------------------------------------------------

FROM python:3.10-slim-bookworm@sha256:5be5aaecb962a41567bc8041f1e9e3432cb085b037fe057f9a562630b2e4b370

ARG APT_MIRROR=
RUN if [ -n "${APT_MIRROR}" ]; then \
        sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi && \
    apt-get update && apt-get install -y --no-install-recommends \
        libsdl2-2.0-0 \
        libsdl2-image-2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# The unix port is a MicroPython interpreter that imports main.py from the
# core/src tree at runtime, so ship both binary and sources. The tree must
# keep the build-time layout — LVGL resolves font/image assets relative to
# the compile-time CURRENT_DIR (/src/core/src/trezor/lvglui), and missing
# font files segfault the display driver on first render.
WORKDIR /opt/onekey
COPY --from=build /src/core/build/unix/trezor-emu-core /opt/onekey/trezor-emu-core
COPY --from=build /src/core/src /src/core/src

# Flash profile lives in $TREZOR_PROFILE_DIR (onekey.flash / onekey.sdcard);
# mount a volume there to persist, or delete the files for a clean state.
ENV TREZOR_PROFILE_DIR=/data \
    SDL_VIDEODRIVER=dummy \
    MICROPYPATH=/src/core/src \
    TREZOR_UDP_IP=0.0.0.0 \
    ONEKEY_UDP_PORT=54935
VOLUME /data
WORKDIR /src/core/src

EXPOSE 54935/udp 54936/udp

# The LVGL font assets need ~20M+ of MicroPython heap after boot.
ENTRYPOINT ["/opt/onekey/trezor-emu-core", "-O0", "-X", "heapsize=32M"]
