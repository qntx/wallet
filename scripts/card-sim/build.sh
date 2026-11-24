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
mkdir -p "$BASE"
# Canonicalize so inside/outside-$DIR checks agree with the realpaths gradle reports.
BASE="$(cd "$BASE" && pwd -P)"
DIR="$BASE/$COMMIT"
LAUNCHER="$DIR/card-sim"
BRIDGE_SRC="$ROOT/scripts/card-sim/Bridge.java"
STAMP="$DIR/.stamp"
MANIFEST="$DIR/.manifest"
BRIDGE_HASH="$(shasum -a 256 "$BRIDGE_SRC" | cut -d' ' -f1)"

# Reuse a build only when it is whole: the stamp matches this Bridge.java and every file the
# launcher references still exists — a restored cache missing staged jars or classes rebuilds
# instead of producing a launcher that dies at run time.
if [ -x "$LAUNCHER" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$BRIDGE_HASH" ] && [ -f "$MANIFEST" ]; then
  missing=
  while IFS= read -r need; do
    [ -e "$need" ] || { missing=1; break; }
  done < "$MANIFEST"
  if [ -z "$missing" ]; then
    echo "$LAUNCHER"
    exit 0
  fi
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

# Stage every classpath entry living outside $DIR into lib/ — gradle's module cache is not part
# of the sim home, so a launcher that references it breaks the moment the cache is restored
# somewhere without it (or cleaned). Name by path hash so same-named jars cannot collide.
LIB="$DIR/lib"
rm -rf "$LIB"
mkdir -p "$LIB"
SELF_CP=""
while IFS= read -r entry; do
  # runtimeClasspath lists output dirs the build may never have created — dead entries are
  # useless to the JVM, drop them rather than copying a missing path.
  [ -e "$entry" ] || continue
  case "$entry" in
    "$DIR"/*) SELF_CP="$SELF_CP:$entry" ;;
    *)
      staged="$LIB/$(printf '%s' "$entry" | shasum -a 256 | cut -c1-8)-$(basename "$entry")"
      if [ -d "$entry" ]; then
        mkdir -p "$staged"
        cp -R "$entry/." "$staged/"
      else
        cp "$entry" "$staged"
      fi
      SELF_CP="$SELF_CP:$staged"
      ;;
  esac
done <<<"$(printf '%s' "$CP" | tr ':' '\n')"
SELF_CP="${SELF_CP#:}"

# The agentJar archive name carries the project version when gradle.properties sets one
# (sim-agent.jar vs sim-agent-<version>.jar) — take whatever the task produced.
AGENT="$(find "$SRC/sim/build/libs" -name 'sim-agent*.jar' -print -quit)"
if [ -z "$AGENT" ]; then
  echo "card-sim: sim agent jar missing after :sim:agentJar" >&2
  exit 1
fi
CLASSES="$DIR/bridge/$BRIDGE_HASH/classes"
mkdir -p "$CLASSES"
"$JAVA_HOME/bin/javac" -cp "$AGENT:$CP" -d "$CLASSES" "$BRIDGE_SRC"

cat >"$LAUNCHER" <<EOF
#!/usr/bin/env bash
# java is resolved at run time — the build machine's JDK path is not baked in.
if [ -n "\${JAVA_HOME:-}" ] && [ -x "\$JAVA_HOME/bin/java" ]; then
  JAVA="\$JAVA_HOME/bin/java"
else
  JAVA="java"
fi
exec "\$JAVA" -javaagent:"$AGENT" -cp "$AGENT:$CLASSES:$SELF_CP" Bridge "\$@"
EOF
chmod +x "$LAUNCHER"
printf '%s' "$BRIDGE_HASH" >"$STAMP"
# Everything the launcher needs, one absolute path per line — the already-built check verifies
# each still exists so a pruned cache rebuilds instead of serving a broken launcher.
{
  printf '%s\n' "$AGENT" "$CLASSES"
  printf '%s' "$SELF_CP" | tr ':' '\n'
} | sed '/^$/d' >"$MANIFEST"
echo "$LAUNCHER"
