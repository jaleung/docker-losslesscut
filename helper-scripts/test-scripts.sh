#!/bin/bash
# Single quotes around ${...} are intended (LosslessCut templates, JSON, JS)
# shellcheck disable=SC2016

# Tests of the scripts added to the image:
# - rootfs/opt/losslesscut-tools/filename-segments (segments from file names)
# - rootfs/opt/losslesscut-tools/settings-defaults.cjs (default settings)
# - rootfs/usr/local/bin/gio (trash)
# - rootfs/opt/losslesscut-tools/autotrim.cjs (background trimming, see
#   test-autotrim.cjs)
# Runs without Docker: needs sh, awk, find, and node for the settings test.

set -euo pipefail

cd "$(dirname "$0")/.."
TOOL=rootfs/opt/losslesscut-tools/filename-segments
GIO=rootfs/usr/local/bin/gio
SETTINGS=rootfs/opt/losslesscut-tools/settings-defaults.cjs
DEFAULTS=rootfs/defaults/losslesscut-settings.json

failures=0
pass() { echo "  ok    $*"; }
fail() { echo "  FAIL  $*"; failures=$((failures + 1)); }

# Usage: expect NAME EXPECTED [DURATION]   (EXPECTED: compact JSON, or "none")
expect() {
    local got
    if got="$(sh "$TOOL" parse "$1" "${3:-}" | tr -d ' \n')"; then :; else got=none; fi
    if [[ "$got" == "$2" ]]; then pass "$1 ${3:+(duration $3) }-> $2"; else fail "$1 -> got $got, expected $2"; fi
}

echo "Parsing file names"
expect 'New Video[6604.630613-9797.852513].mp4' '[{"start":6604.630613,"end":9797.852513,"name":""}]'
expect 'New Video[1.5-4,8.25-12].mp4' '[{"start":1.5,"end":4,"name":""},{"start":8.25,"end":12,"name":""}]'
expect 'clip[0-120].mkv' '[{"start":0,"end":120,"name":""}]'
expect 'clip[0-end].mkv' '[{"start":0,"name":""}]'
expect 'clip[6196-END].MP4' '[{"start":6196,"name":""}]'
expect 'clip[ 10 - 20 , 30-end ].mp4' '[{"start":10,"end":20,"name":""},{"start":30,"name":""}]'
expect 'clip[ 10 - 20 , 30-end ].mp4' '[{"start":10,"end":20,"name":""},{"start":30,"end":95.5,"name":""}]' 95.5
expect 'clip[0-end].mp4' '[{"start":0,"end":12.04,"name":""}]' 12.04
expect 'clip[30-end].mp4' none 20
expect 'clip[0006604.630-0009797.85].mp4' '[{"start":6604.630,"end":9797.85,"name":""}]'
expect 'clip[0.5-1].mp4' '[{"start":0.5,"end":1,"name":""}]'
expect 'my [draft] clip[5-6].mp4' '[{"start":5,"end":6,"name":""}]'
# Block at the start of the name
expect '[0-968.968000,2080.078000-4197.393200,4682.678000-end]new video.mp4' \
    '[{"start":0,"end":968.968000,"name":""},{"start":2080.078000,"end":4197.393200,"name":""},{"start":4682.678000,"name":""}]'
expect '[0-968.968000,2080.078000-4197.393200,4682.678000-end]new video.mp4' \
    '[{"start":0,"end":968.968000,"name":""},{"start":2080.078000,"end":4197.393200,"name":""},{"start":4682.678000,"end":5000.5,"name":""}]' 5000.5
expect '[5-6]my [draft] clip.mp4' '[{"start":5,"end":6,"name":""}]'
expect '[5-6] clip.mp4' '[{"start":5,"end":6,"name":""}]'
expect '[draft]clip[5-6].mp4' '[{"start":5,"end":6,"name":""}]'
expect '[1-2]clip[3-4].mp4' '[{"start":1,"end":2,"name":""}]'
expect '[1-2].mp4' '[{"start":1,"end":2,"name":""}]'
expect '[1.5-2]clip' '[{"start":1.5,"end":2,"name":""}]'
expect 'clip[1.5-2]' '[{"start":1.5,"end":2,"name":""}]'
expect '[2-1]clip.mp4' none
expect 'clip [1-2] copy.mp4' none
expect 'Holiday[draft].mp4' none
expect 'clip[20-10].mp4' none
expect 'clip[10-10].mp4' none
expect 'clip[1-2,].mp4' none
expect 'clip[1-2,3].mp4' none
expect 'clip[].mp4' none
expect 'clip[-5].mp4' none
expect 'clip[1,5-2].mp4' none
expect 'clip[1:00-2:00].mp4' none
expect '[0-003747.014316-end]sone-521-4k.mp4' none
expect 'clip[1-2] copy.mp4' none
expect 'clip.mp4' none

echo "Generating project files"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# Fake ffprobe: every file lasts 42.5s, except empty ones (e.g. still copying)
mkdir "$tmp/bin"
cat > "$tmp/bin/ffprobe" <<'FFPROBE'
#!/bin/sh
for last; do :; done
[ -s "$last" ] && echo 42.5
FFPROBE
chmod +x "$tmp/bin/ffprobe"
export LOSSLESSCUT_FFPROBE="$tmp/bin/ffprobe"
mkdir -p "$tmp/sub" "$tmp/.Trash-1000/files" "$tmp/@Recycle" "$tmp/.@__thumb"
echo data > "$tmp/sub/b[0-end].MKV"
echo data > "$tmp/sub/b3[1 - END].mp4"
echo data > "$tmp/sub/[2-end]front.mp4"
touch "$tmp/incomplete[5-end].mp4"
touch "$tmp/a[1-2].mp4" "$tmp/c[bad].mp4" "$tmp/d[1-2].txt" \
    "$tmp/.Trash-1000/files/e[1-2].mp4" "$tmp/@Recycle/f[1-2].mp4" "$tmp/.@__thumb/g[1-2].mp4" "$tmp/h[3-4].mp4"
echo '{"version":2,"cutSegments":[{"start":0,"end":1,"name":"mine"}]}' > "$tmp/h[3-4]-proj.llc"
sh "$TOOL" scan "$tmp" > /dev/null
check_exists() { if [[ -f "$1" ]]; then pass "created $(basename "$1")"; else fail "missing $1"; fi; }
check_absent() { if [[ ! -e "$1" ]]; then pass "no $(basename "$1")"; else fail "unexpected $1"; fi; }
check_exists "$tmp/a[1-2]-proj.llc"
check_exists "$tmp/sub/b[0-end]-proj.llc"
if grep -q '"end": 42.5' "$tmp/sub/b[0-end]-proj.llc"; then pass "end -> duration"; else fail "end not set to the duration: $(cat "$tmp/sub/b[0-end]-proj.llc")"; fi
check_exists "$tmp/sub/b3[1 - END]-proj.llc"
check_exists "$tmp/sub/[2-end]front-proj.llc"
if grep -q '"start": 2, "end": 42.5' "$tmp/sub/[2-end]front-proj.llc"; then pass "block at the start"; else fail "block at the start: $(cat "$tmp/sub/[2-end]front-proj.llc")"; fi
check_absent "$tmp/incomplete[5-end]-proj.llc"
check_absent "$tmp/c[bad]-proj.llc"
check_absent "$tmp/d[1-2]-proj.llc"
check_absent "$tmp/.Trash-1000/files/e[1-2]-proj.llc"
check_absent "$tmp/@Recycle/f[1-2]-proj.llc"
check_absent "$tmp/.@__thumb/g[1-2]-proj.llc"
if grep -q '"name":"mine"' "$tmp/h[3-4]-proj.llc"; then pass "existing project kept"; else fail "existing project overwritten"; fi
if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$tmp/a[1-2]-proj.llc" 2>/dev/null; then
    pass "generated project is valid JSON"
else
    fail "generated project is not valid JSON: $(cat "$tmp/a[1-2]-proj.llc")"
fi

echo "Removing generated project files of deleted videos"
rm "$tmp/a[1-2].mp4" "$tmp/h[3-4].mp4"
sh "$TOOL" remove-orphan "$tmp/a[1-2].mp4" > /dev/null
sh "$TOOL" remove-orphan "$tmp/h[3-4].mp4" > /dev/null
check_absent "$tmp/a[1-2]-proj.llc"
if [[ -f "$tmp/h[3-4]-proj.llc" ]]; then pass "project saved by LosslessCut kept"; else fail "project saved by LosslessCut removed"; fi
# Renamed while not watching: the next scan cleans up
mv "$tmp/sub/b[0-end].MKV" "$tmp/sub/b2[0-end].MKV"
sh "$TOOL" scan "$tmp" > /dev/null
check_absent "$tmp/sub/b[0-end]-proj.llc"
check_exists "$tmp/sub/b2[0-end]-proj.llc"
mv "$tmp/sub/[2-end]front.mp4" "$tmp/sub/[2-end]front2.mp4"
sh "$TOOL" scan "$tmp" > /dev/null
check_absent "$tmp/sub/[2-end]front-proj.llc"
check_exists "$tmp/sub/[2-end]front2-proj.llc"

echo "Folders mapped into the container"
m="$tmp/mapped"
mkdir -p "$m/medias/Download" "$m/my videos" "$m/storage"
touch "$m/single.txt"
printf '%s\n' \
    "1 0 0:50 / / rw,relatime - overlay overlay rw" \
    "2 1 0:5 / /proc rw - proc proc rw" \
    "3 1 0:6 / /dev rw - tmpfs tmpfs rw" \
    "4 3 0:7 / /dev/dri rw - devtmpfs udev rw" \
    "5 1 253:0 /Container/losslesscut /config rw,relatime - ext4 /dev/mapper/cachedev1 rw" \
    "6 1 253:0 /Multimedia $m/medias rw,relatime master:1 - ext4 /dev/mapper/cachedev1 rw" \
    "7 6 253:0 /Download $m/medias/Download rw,relatime - ext4 /dev/mapper/cachedev1 rw" \
    "8 1 253:0 /Videos $m/my\\040videos rw,relatime - ext4 /dev/mapper/cachedev1 rw" \
    "9 1 253:0 /hosts /etc/hosts rw,relatime - ext4 /dev/mapper/cachedev1 rw" \
    "10 1 253:0 /single.txt $m/single.txt rw,relatime - ext4 /dev/mapper/cachedev1 rw" \
    "11 1 0:8 / $m/storage rw - tmpfs tmpfs rw" > "$m/mountinfo"
got="$(LOSSLESSCUT_MOUNTINFO="$m/mountinfo" sh "$TOOL" mapped-folders | tr '\n' '|')"
if [[ "$got" == "$m/medias|$m/my videos|" ]]; then pass "mapped folders"; else fail "mapped folders: $got"; fi

echo "Settings defaults"
if command -v node > /dev/null; then
    # Usage: settings CONFIG_JSON EXPECTED_KEYS
    settings() {
        local cfg="$tmp/config.json" got
        if [[ "$1" == missing ]]; then rm -f "$cfg"; else echo "$1" > "$cfg"; fi
        got="$(node "$SETTINGS" "$cfg" "$DEFAULTS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s)).sort().join(",")))')"
        if [[ "$got" == "$2" ]]; then pass "config $1 -> apply [$2]"; else fail "config $1 -> apply [$got], expected [$2]"; fi
    }
    settings missing 'cleanupChoices,mergedFileTemplate,outSegTemplate'
    settings '{}' 'cleanupChoices,mergedFileTemplate,outSegTemplate'
    settings '{"cleanupChoices":{"trashTmpFiles":true,"askForCleanup":true,"closeFile":true,"cleanupAfterExport":false}}' 'cleanupChoices,mergedFileTemplate,outSegTemplate'
    settings '{"cleanupChoices":{"trashTmpFiles":false,"askForCleanup":true,"closeFile":true}}' 'mergedFileTemplate,outSegTemplate'
    settings '{"outSegTemplate":"${FILENAME}-x${EXT}","mergedFileTemplate":"${FILENAME}-y${EXT}"}' 'cleanupChoices'
    settings 'not json' 'cleanupChoices,mergedFileTemplate,outSegTemplate'
    # The template must survive JSON escaping
    template="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).outSegTemplate)' "$DEFAULTS")"
    if [[ "$template" == '${FILENAME.replace(/\[[^\]]*\]\s*/g, '"''"').toUpperCase()}-trimmed${EXT}' ]]; then
        pass "template: $template"
    else
        fail "template: $template"
    fi
    # Usage: template_output FILENAME EXPECTED (evaluated like LosslessCut does: a JS template string)
    template_output() {
        local out
        out="$(node -e '
            const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).outSegTemplate;
            const FILENAME = process.argv[2], EXT = ".mp4";
            console.log(eval("`" + t + "`"));' "$DEFAULTS" "$1")"
        if [[ "$out" == "$2" ]]; then pass "$1.mp4 -> $out"; else fail "$1.mp4 -> $out, expected $2"; fi
    }
    template_output 'New Video[6604.630613-9797.852513]' 'NEW VIDEO-trimmed.mp4'
    template_output 'my [draft] clip[5-6]' 'MY CLIP-trimmed.mp4'
    template_output '[0-10] New Video' 'NEW VIDEO-trimmed.mp4'
else
    echo "  skipped (node not found)"
fi

echo "Trash (gio wrapper)"
# /config and /storage as two mounts of the same disk (e.g. two shared folders
#  of a NAS volume), simulated with a mount table
g="$tmp/gio"
mkdir -p "$g/config/xdg/data" "$g/storage/sub dir"
printf '%s\n' \
    "1 0 0:50 / / rw - overlay overlay rw" \
    "2 1 8:1 /Container/losslesscut $g/config rw - ext4 /dev/sda1 rw" \
    "3 1 8:1 /Multimedia $g/storage rw - ext4 /dev/sda1 rw" > "$g/mountinfo"
# Real gio: only logs its arguments
printf '#!/bin/sh\necho "$*" >> "${0%%/*}/gio-real.log"\n' > "$tmp/bin/gio-real"
chmod +x "$tmp/bin/gio-real"
trash() {
    GIO_REAL="$tmp/bin/gio-real" GIO_MOUNTINFO="$g/mountinfo" HOME="$g/config" \
        XDG_DATA_HOME="$g/config/xdg/data" sh "$GIO" trash "$@" 2>/dev/null
}
t="$g/storage/.Trash-$(id -u)"
video="$g/storage/sub dir/New Video[1-2].mp4"
echo a > "$video"
if trash "$video"; then pass "trash exit code"; else fail "trash exit code"; fi
check_exists "$t/files/New Video[1-2].mp4"
check_absent "$video"
info="$t/info/New Video[1-2].mp4.trashinfo"
if grep -qx 'Path=sub%20dir/New%20Video%5B1-2%5D.mp4' "$info" \
    && grep -qE '^DeletionDate=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$' "$info"; then
    pass "trash info"
else
    fail "trash info: $(cat "$info")"
fi
if [[ "$(stat -c %a "$t")" == 700 ]]; then pass "trash folder private"; else fail "trash folder mode $(stat -c %a "$t")"; fi
echo b > "$video"
trash "$video" || true
check_exists "$t/files/New Video[1-2].2.mp4"
echo c > "$g/config/settings.txt"
trash "$g/config/settings.txt" || true
if grep -qxF "trash -- $g/config/settings.txt" "$tmp/bin/gio-real.log"; then pass "home folder: real gio"; else fail "home folder not passed to gio"; fi
if trash "$g/storage/missing.mp4"; then fail "missing file: exit 0"; else pass "missing file: exit 1"; fi
GIO_REAL="$tmp/bin/gio-real" sh "$GIO" --version
if grep -qx -- "--version" "$tmp/bin/gio-real.log"; then pass "other commands: real gio"; else fail "other commands not passed to gio"; fi

if command -v node > /dev/null; then
    node helper-scripts/test-autotrim.cjs || failures=$((failures + 1))
fi

if [[ $failures -gt 0 ]]; then
    echo "$failures test(s) failed"
    exit 1
fi
echo "All tests passed"
