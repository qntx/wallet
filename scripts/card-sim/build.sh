#!/usr/bin/env bash
# Builds the qntx card simulator harness: clones qntx/wallet-applet at the commit pinned in
# vectors/card/SOURCE, builds its sim agent jar plus applet and host classes, collects the runtime
# classpath through a Gradle init script, compiles scripts/card-sim/Bridge.java and writes an
# executable launcher. Everything applet-specific lives in this script so a future prebuilt
# simulator artefact only changes it. Prints the launcher path as its last stdout line.
#
#   QNTX_CARD_SIM_HOME  build root (default ~/.cache/qntx-card-sim)
#   JAVA_HOME           JDK 25 (default ~/.jdks/temurin-25/Contents/Home)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMMIT="$(sed -n 's/^commit \([0-9a-f]\{40\}\)$/\1/p' "$ROOT/vectors/card/SOURCE")"
if [ -z "$COMMIT" ]; then
  echo "card-sim: vectors/card/SOURCE has no commit line" >&2
  exit 1
fi

BASE="${QNTX_CARD_SIM_HOME:-$HOME/.cache/qntx-card-sim}"
DIR="$BASE/$COMMIT"
LAUNCHER="$DIR/card-sim"
BRIDGE_SRC="$ROOT/scripts/card-sim/Bridge.java"
STAMP="$DIR/.stamp"
BRIDGE_HASH="$(shasum -a 256 "$BRIDGE_SRC" | cut -d' ' -f1)"

if [ -x "$LAUNCHER" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$BRIDGE_HASH" ]; then
  echo "$LAUNCHER"
  exit 0
fi

if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
  :
elif [ -x "$HOME/.jdks/temurin-25/Contents/Home/bin/java" ]; then
  JAVA_HOME="$HOME/.jdks/temurin-25/Contents/Home"
else
  echo "card-sim: JDK 25 not found — set JAVA_HOME or install temurin 25 into ~/.jdks" >&2
  exit 1
fi
export JAVA_HOME

mkdir -p "$DIR"
SRC="$DIR/src"
if [ ! -d "$SRC/.git" ]; then
  rm -rf "$SRC"
  mkdir -p "$SRC"
  git -C "$SRC" init -q
  git -C "$SRC" remote add origin https://github.com/qntx/wallet-applet.git
fi
if [ "$(git -C "$SRC" rev-parse HEAD 2>/dev/null || true)" != "$COMMIT" ]; then
  git -C "$SRC" fetch -q --depth 1 origin "$COMMIT"
  git -C "$SRC" checkout -q FETCH_HEAD
fi
git -C "$SRC" submodule update --init --depth 1 ||
  git -C "$SRC" submodule update --init

# Gradle init script: a qntxRuntimeCp task on every java project printing its runtime classpath
# (compiled output dirs + dependency jars) on one QNTXCP line — no jar versions are picked by hand.
INIT="$DIR/cp-init.gradle"
cat >"$INIT" <<'EOF'
allprojects { project ->
    project.plugins.withId("java") {
        project.tasks.register("qntxRuntimeCp") {
            doLast {
                def ss = project.extensions.getByName("sourceSets")
                def cp = ss.getByName("main").runtimeClasspath.files
                        .collect { it.absolutePath }
                        .join(File.pathSeparator)
                println("QNTXCP:" + project.name + ":" + cp)
            }
        }
    }
}
EOF

GRADLE_OUT="$("$SRC/gradlew" -p "$SRC" --quiet --init-script "$INIT" \
  :sim:agentJar :applet:classes :host:classes \
  :sim:qntxRuntimeCp :applet:qntxRuntimeCp :host:qntxRuntimeCp 2>&1)" || {
  echo "$GRADLE_OUT" >&2
  echo "card-sim: applet build failed" >&2
  exit 1
}

CP=""
while IFS= read -r line; do
  case "$line" in
    QNTXCP:*:*) CP="$CP:${line#QNTXCP:*:}" ;;
  esac
done <<<"$GRADLE_OUT"
CP="$(printf '%s' "$CP" | tr ':' '\n' | sed '/^$/d' | sort -u | paste -sd: -)"

AGENT="$SRC/sim/build/libs/sim-agent.jar"
CLASSES="$DIR/bridge/$BRIDGE_HASH/classes"
mkdir -p "$CLASSES"
"$JAVA_HOME/bin/javac" -cp "$AGENT:$CP" -d "$CLASSES" "$BRIDGE_SRC"

cat >"$LAUNCHER" <<EOF
#!/usr/bin/env bash
exec "$JAVA_HOME/bin/java" -javaagent:"$AGENT" -cp "$AGENT:$CLASSES:$CP" Bridge "\$@"
EOF
chmod +x "$LAUNCHER"
printf '%s' "$BRIDGE_HASH" >"$STAMP"
echo "$LAUNCHER"
