#!/bin/bash

# Smoke test for the LosslessCut image: start it with NAS-like resource limits,
#  check it's healthy, then through LosslessCut's HTTP API:
#  - export a video: output named after the image's default template, source
#    moved to the trash (default cleanup settings)
#  - open a video named "[2-5,8-end]....mp4" in a second mapped folder
#    (/medias): segments loaded from the name, exported and merged, source
#    moved to the trash of that folder
#  Then background trimming (auto-trim): off by default, switched on through
#  nginx like the side panel does, videos trimmed one at a time, never
#  overwriting, keeping the originals' modified date, permissions and tags,
#  sources in the trash, a video being edited in LosslessCut left waiting, and
#  its views in a browser (status box, side panel tab badge, side panel,
#  status page with its video renaming, dark mode and paged results), and a
#  video renamed on the status page trimmed in turn.
#  Then, in a second container with the image defaults (HTTPS and
#  WEB_NOTIFICATION), check that the "Export finished" notification is sent.
#
# Usage: helper-scripts/smoke-test.sh [IMAGE]
#
# Environment:
#   OUT_DIR       where logs and screenshots are written (./smoke-test-output)
#   SMOKE_CPUS    CPU limit (3)
#   SMOKE_MEMORY  memory limit (2g)
#   SMOKE_TIMEOUT seconds to wait for the container to become healthy (300)
#
# Screenshots are taken if vncdo (pip install vncdotool) is available. The
#  auto-trim views are checked if node and playwright-core (or playwright) are
#  available, with Chrome from CHROME_PATH or Playwright's browsers.

set -euo pipefail

IMAGE="${1:-ghcr.io/jaleung/docker-losslesscut:latest}"
OUT_DIR="${OUT_DIR:-$PWD/smoke-test-output}"
SMOKE_CPUS="${SMOKE_CPUS:-3}"
SMOKE_MEMORY="${SMOKE_MEMORY:-2g}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-300}"

NAME_PREFIX="losslesscut-smoke-$$"
NAME="$NAME_PREFIX"
NOTIF_NAME="${NAME_PREFIX}-notifications"
VOLUME="${NAME_PREFIX}-storage"
CONFIG_VOLUME="${NAME_PREFIX}-config"
# A second share, mapped elsewhere than /storage
MEDIA_VOLUME="${NAME_PREFIX}-medias"
CLIP=/storage/smoke-test.mp4
SEGMENTS_CLIP='/storage/smoke-segments[2-5,8-end].mp4'
FRONT_CLIP='/medias/[2-5,8-end]smoke front.mp4'
NOTIF_CLIP=/storage/notify-test.mp4
API_PORT=8080

mkdir -p "$OUT_DIR"

log() { echo "[smoke-test] $*"; }
fail() { echo "[smoke-test] FAIL: $*" >&2; exit 1; }

# Save the logs of a container, then remove it
# Usage: remove_container NAME
remove_container() {
    docker container inspect "$1" >/dev/null 2>&1 || return 0
    docker logs "$1" > "$OUT_DIR/$1.log" 2>&1 || true
    docker exec "$1" cat /config/xdg/config/LosslessCut/app.log \
        > "$OUT_DIR/$1-losslesscut.log" 2>&1 || true
    docker rm -f -v "$1" >/dev/null 2>&1 || true
}

cleanup() {
    rc=$?
    remove_container "$NAME_PREFIX"
    remove_container "$NOTIF_NAME"
    docker volume rm -f "$VOLUME" "$CONFIG_VOLUME" "$MEDIA_VOLUME" >/dev/null 2>&1 || true
    if [[ $rc -ne 0 ]]; then
        log "Last lines of the container log (full logs in $OUT_DIR):"
        tail -n 50 "$OUT_DIR/$NAME.log" 2>/dev/null || true
    fi
    exit $rc
}
trap cleanup EXIT

# Start $NAME with a clip to open and the HTTP API
# Usage: start_container CLIP [DOCKER RUN ARGS...]
start_container() {
    local clip="$1"
    shift
    docker run -d --name "$NAME" \
        --cpus "$SMOKE_CPUS" --memory "$SMOKE_MEMORY" \
        -v "$VOLUME:/storage" \
        -e LOSSLESSCUT_ARGS="--http-api $API_PORT $clip" \
        "$@" "$IMAGE" >/dev/null
}

wait_healthy() {
    log "Waiting up to ${SMOKE_TIMEOUT}s for the container to become healthy"
    local start=$SECONDS state
    while true; do
        state="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$NAME")"
        case "$state" in
            "running healthy") break ;;
            running*) ;;
            *) fail "container is not running: $state" ;;
        esac
        (( SECONDS - start < SMOKE_TIMEOUT )) || fail "container not healthy after ${SMOKE_TIMEOUT}s: $state"
        sleep 5
    done
    log "Healthy after $(( SECONDS - start ))s"
}

wait_api() {
    log "Waiting for the HTTP API"
    local response
    for _ in $(seq 1 30); do
        response="$(api GET / 10 2>/dev/null)" || true
        [[ "$response" == "HTTP/1.1 200"* ]] && return 0
        sleep 2
    done
    fail "HTTP API not reachable"
}

# Run a command in the container as the app user, with the app's environment
app_exec() {
    docker exec -u 1000:1000 -e HOME=/config "$NAME" "$@"
}

# Call LosslessCut's HTTP API, it only listens on localhost in the container
# Usage: api METHOD PATH [TIMEOUT] [JSON BODY]
api() {
    local body="${4:-}"
    app_exec sh -c "printf '%s %s HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' \
        '$1' '$2' '${#body}' '$body' | timeout ${3:-60} nc 127.0.0.1 $API_PORT"
}

# Usage: wait_for_file PATH [SECONDS]
wait_for_file() {
    for _ in $(seq 1 "${2:-60}"); do
        docker exec "$NAME" test -e "$1" && return 0
        sleep 1
    done
    return 1
}

# Duration of a media file in the container, once it's complete
# Usage: media_duration PATH
media_duration() {
    local duration
    for _ in $(seq 1 30); do
        duration="$(docker exec -e LD_LIBRARY_PATH=/LosslessCut/resources "$NAME" /LosslessCut/resources/ffprobe \
            -v error -show_entries format=duration -of default=nw=1:nk=1 "$1" 2>/dev/null)" || true
        if awk -v d="${duration:-0}" 'BEGIN { exit !(d > 1) }'; then
            echo "$duration"
            return 0
        fi
        sleep 2
    done
    return 1
}

# Usage: between VALUE MIN MAX
between() {
    awk -v v="$1" -v min="$2" -v max="$3" 'BEGIN { exit !(v >= min && v <= max) }'
}

# Export the opened file, wait for the output and check its duration
# Usage: export_and_check OUTPUT MIN_DURATION MAX_DURATION
export_and_check() {
    local output="$1" duration
    for attempt in 1 2 3; do
        api POST /api/action/export 180 >/dev/null 2>&1 || true
        wait_for_file "$output" 60 && break
        log "  no output yet (attempt $attempt)"
    done
    docker exec "$NAME" test -e "$output" \
        || fail "export didn't produce $output, files: $(docker exec "$NAME" find /storage -type f | tr '\n' ' ')"
    duration="$(media_duration "$output")" || fail "exported file looks broken: $output"
    echo "  exported: $output (${duration}s)"
    between "$duration" "$2" "$3" || fail "unexpected duration ${duration}s for $output (expected $2-$3s)"
}

# Usage: check_trashed PATH  (moved by the cleanup to the trash of the mapped
#  folder, e.g. /storage/.Trash-1000)
check_trashed() {
    local name trash
    name="$(basename "$1")"
    trash="/$(echo "$1" | cut -d/ -f2)/.Trash-1000"
    wait_for_file "$trash/files/$name" 30 || fail "$1 wasn't moved to $trash"
    docker exec "$NAME" test ! -e "$1" || fail "$1 still exists after the cleanup"
    echo "  trashed: $1"
}

# Usage: log_has PATTERN  (grep in the container log)
# Not "docker logs | grep -q": grep exits at the first match, docker logs then
#  gets SIGPIPE, which fails the pipeline with pipefail
log_has() {
    local logs
    logs="$(docker logs "$NAME" 2>&1)"
    grep -q -- "$1" <<< "$logs"
}

# Background trimming API, through nginx like the side panel
# Usage: autotrim_api METHOD PATH [JSON BODY]
autotrim_api() {
    if [[ $# -ge 3 ]]; then
        curl -fsS -X "$1" -H 'Content-Type: application/json' -d "$3" "http://127.0.0.1:$WEB_PORT/autotrim/$2"
    else
        curl -fsS -X "$1" "http://127.0.0.1:$WEB_PORT/autotrim/$2"
    fi
}

# Main LosslessCut process: Electron's children have --type=..., and the
#  background trimming runs LosslessCut's Electron too (autotrim.cjs)
main_pid() {
    docker exec "$NAME" sh -c '
        for p in $(pidof losslesscut); do
            case "$(tr "\0" " " < "/proc/$p/cmdline")" in
                *--type=*|*autotrim.cjs*) ;;
                *) echo "$p"; exit 0 ;;
            esac
        done
        exit 1'
}

# Background trimming process
autotrim_pid() {
    docker exec "$NAME" sh -c '
        for p in $(pidof losslesscut); do
            case "$(tr "\0" " " < "/proc/$p/cmdline")" in
                *autotrim.cjs*) echo "$p"; exit 0 ;;
            esac
        done
        exit 1'
}

screenshot() {
    if command -v vncdo >/dev/null; then
        vncdo -s "127.0.0.1::$VNC_PORT" --delay 0 "$@" || log "WARNING: screenshot failed"
    fi
}

log "Image: $IMAGE"

log "Generating test clips (20s, a keyframe every 2s)"
docker volume create "$VOLUME" >/dev/null
docker run --rm -v "$VOLUME:/storage" --entrypoint sh "$IMAGE" -c "
    LD_LIBRARY_PATH=/LosslessCut/resources /LosslessCut/resources/ffmpeg -hide_banner -loglevel error \
        -f lavfi -i testsrc2=size=1280x720:rate=25 -f lavfi -i sine=frequency=440 \
        -t 20 -g 50 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest -y $CLIP \
    && cp $CLIP '$SEGMENTS_CLIP' && cp $CLIP '/storage/smoke-invalid[5-2].mp4' && cp $CLIP $NOTIF_CLIP \
    && chown -R 1000:1000 /storage"
# /medias: a video with segments at the front of its name, and in /medias/auto,
#  videos for background trimming
media_setup="$(cat <<'SETUP'
set -e
clip="$1"
cp "$clip" "$2"
mkdir /medias/auto
# With tags, an old modified date and mode 664, to be kept in the trimmed videos
for name in '[2-5,8-end]auto one.mp4' '[0-3]auto two.mp4'; do
    LD_LIBRARY_PATH=/LosslessCut/resources /LosslessCut/resources/ffmpeg -hide_banner -loglevel error \
        -i "$clip" -map 0 -c copy -metadata title='Smoke title' -metadata comment='Keep me' \
        -metadata creation_time=2020-01-02T03:04:05Z -y "/medias/auto/$name"
    touch -d '2020-01-02 03:04:05' "/medias/auto/$name"
    chmod 664 "/medias/auto/$name"
done
# Name already taken: the trimmed video gets " (2)"
cp "$clip" '/medias/auto/AUTO TWO-trimmed.mp4'
# Renamed on the status page (keyframes every 2s, like the clip)
cp "$clip" '/medias/rename me.mp4'
# Being edited in LosslessCut: a project file saved by LosslessCut (without the
#  generator's marker), there before the video so it's not generated
cat > '/medias/auto/[0-3]edited-proj.llc' <<'LLC'
{
  version: 2,
  mediaFileName: '[0-3]edited.mp4',
  cutSegments: [
    {
      start: 0,
      end: 1,
      name: '',
    },
  ],
}
LLC
cp "$clip" '/medias/auto/[0-3]edited.mp4'
chown -R 1000:1000 /medias
SETUP
)"
docker volume create "$MEDIA_VOLUME" >/dev/null
docker run --rm -v "$VOLUME:/storage" -v "$MEDIA_VOLUME:/medias" --entrypoint sh "$IMAGE" \
    -c "$media_setup" sh "$CLIP" "$FRONT_CLIP"

# LosslessCut settings as if the user had set them: no confirmation before
#  exporting, export + merge. The image's defaults are added on top
docker volume create "$CONFIG_VOLUME" >/dev/null
docker run --rm -v "$CONFIG_VOLUME:/config" --entrypoint sh "$IMAGE" -c "
    mkdir -p /config/xdg/config/LosslessCut \
    && echo '{ \"exportConfirmEnabled\": false, \"autoMerge\": true, \"enableAskForFileOpenAction\": false }' \
        > /config/xdg/config/LosslessCut/config.json \
    && chown -R 1000:1000 /config"

log "Starting the container (cpus=$SMOKE_CPUS, memory=$SMOKE_MEMORY)"
# HTTP: with HTTPS (the default), VNC is behind SSL, which vncdo can't use
# Auto-trim: scans every 5s, picks videos unchanged for 3s
start_container "$CLIP" -v "$CONFIG_VOLUME:/config" -v "$MEDIA_VOLUME:/medias" \
    -p 127.0.0.1::5800 -p 127.0.0.1::5900 -e DISPLAY_WIDTH=1280 -e DISPLAY_HEIGHT=720 \
    -e SECURE_CONNECTION=0 -e WEB_NOTIFICATION=0 -e LOSSLESSCUT_AUTOTRIM_INTERVAL=5 -e AUTOTRIM_SETTLE=3

WEB_PORT="$(docker port "$NAME" 5800/tcp | head -n 1 | sed 's/.*://')"
VNC_PORT="$(docker port "$NAME" 5900/tcp | head -n 1 | sed 's/.*://')"

wait_healthy

log "Checking shared libraries"
docker exec "$NAME" sh -c '
    export LD_LIBRARY_PATH=/LosslessCut/resources
    ! ldd /LosslessCut/losslesscut /LosslessCut/resources/ffmpeg /LosslessCut/resources/ffprobe | grep "not found"
' || fail "missing shared libraries"

log "Checking ffmpeg"
docker exec -e LD_LIBRARY_PATH=/LosslessCut/resources "$NAME" /LosslessCut/resources/ffmpeg -hide_banner -version | sed -n 1p

log "Checking the web UI"
curl -fsS -o /dev/null "http://127.0.0.1:$WEB_PORT/" || fail "web UI not reachable"

log "Checking the LosslessCut process"
pid="$(main_pid)" || fail "LosslessCut main process not found"
cmdline="$(docker exec "$NAME" sh -c "tr '\0' ' ' < /proc/$pid/cmdline")"
echo "  cmdline: $cmdline"
for flag in --no-sandbox --disable-dev-shm-usage --disable-gpu --disable-networking; do
    [[ " $cmdline " == *" $flag "* ]] || fail "missing flag $flag"
done
uid="$(docker exec "$NAME" awk '/^Uid:/{print $2}' "/proc/$pid/status")"
[[ "$uid" == 1000 ]] || fail "LosslessCut runs as uid $uid instead of 1000"
nice="$(docker exec "$NAME" awk '{print $19}' "/proc/$pid/stat")"
[[ "$nice" == 10 ]] || fail "LosslessCut niceness is $nice instead of 10"
echo "  uid: $uid, niceness: $nice"

log "Checking the default settings"
log_has "Applying default settings: .*trimmed.*cleanupAfterExport" \
    || fail "the image's default settings weren't applied"
echo "  $(docker logs "$NAME" 2>&1 | grep -m 1 -o "Applying default settings.*" | cut -c1-120)..."

log "Checking segments from file names"
# Every folder mapped into the container is watched
log_has "scanning /medias /storage" \
    || fail "the mapped folders aren't all watched: $(docker logs "$NAME" 2>&1 | grep -m 1 "scanning")"
segments_llc="${SEGMENTS_CLIP%.mp4}-proj.llc"
front_llc="${FRONT_CLIP%.mp4}-proj.llc"
for llc in "$segments_llc" "$front_llc"; do
    wait_for_file "$llc" 30 || fail "no project file created: $llc"
    echo "  $llc:"
    docker exec "$NAME" cat "$llc" | sed 's/^/    /'
    docker exec "$NAME" grep -q '"start": 8, "end": 20' "$llc" || fail "\"8-end\" wasn't converted using the duration in $llc"
done
docker exec "$NAME" test ! -e '/storage/smoke-invalid[5-2]-proj.llc' || fail "project file created for an invalid name"
# Watching: a video added while running
docker exec -u 1000:1000 "$NAME" sh -c "mkdir -p /medias/sub && cp $CLIP '/medias/sub/[0-3]late.mp4'"
wait_for_file '/medias/sub/[0-3]late-proj.llc' 15 || fail "no project file created for a video added while running"
echo "  created for a new video: /medias/sub/[0-3]late-proj.llc"

log "Checking the trash"
# /config and /storage are two volumes on the same disk, like two shared
#  folders of a NAS: gio alone fails with "across filesystem boundaries"
docker exec "$NAME" stat -c '  device %d: %n' /config /storage
app_exec sh -c 'echo test > /storage/trash-test.txt && gio trash /storage/trash-test.txt' \
    || fail "gio trash failed"
wait_for_file /storage/.Trash-1000/files/trash-test.txt 5 || fail "gio trash didn't use /storage/.Trash-1000"
echo "  trashed to /storage/.Trash-1000"

wait_api
# Give the file some time to load
sleep 10
screenshot capture "$OUT_DIR/01-file-opened.png"

log "Exporting through the HTTP API (output name and cleanup from the default settings)"
export_and_check /storage/SMOKE-TEST-trimmed.mp4 19 21
check_trashed "$CLIP"
screenshot capture "$OUT_DIR/02-exported.png" key esc pause 1

log "Opening a video with segments in its name, exporting and merging"
api POST /api/action/openFiles 30 "[\"$FRONT_CLIP\"]" >/dev/null 2>&1 || fail "could not open $FRONT_CLIP"
sleep 10
screenshot capture "$OUT_DIR/03-segments-loaded.png"
# 2-5 + 8-20 (the cuts start on keyframes, every 2s)
export_and_check '/medias/SMOKE FRONT-trimmed.mp4' 14.5 15.6
check_trashed "$FRONT_CLIP"
check_trashed "$front_llc"
screenshot capture "$OUT_DIR/04-segments-exported.png" key esc pause 1

if command -v vncdo >/dev/null; then
    log "Checking the file dialog"
    api POST /api/action/openFilesDialog 10 >/dev/null 2>&1 || fail "could not open the file dialog"
    sleep 5
    # Typing in the dialog searches the current folder. Closing it can take
    #  several Esc while searching
    screenshot capture "$OUT_DIR/05-open-dialog.png" \
        type smoke pause 3 capture "$OUT_DIR/06-dialog-search.png" \
        key esc pause 1 key esc pause 1 key esc pause 2
    # GTK saves the file chooser settings when it's closed (GSETTINGS_BACKEND)
    keyfile=/config/xdg/config/glib-2.0/settings/keyfile
    for _ in $(seq 1 10); do
        docker exec "$NAME" test -s "$keyfile" && break
        sleep 1
    done
    docker exec "$NAME" test -s "$keyfile" || fail "the file dialog settings weren't saved to $keyfile"
    docker exec "$NAME" cat "$keyfile" | sed 's/^/  /'
fi

log "Checking background trimming (auto-trim)"
page="$(curl -fsS "http://127.0.0.1:$WEB_PORT/")" || fail "web UI not reachable"
grep -q 'src="app/autotrim.js' <<< "$page" || fail "the side panel script isn't in the web page"
curl -fsS -o /dev/null "http://127.0.0.1:$WEB_PORT/app/autotrim.js" || fail "app/autotrim.js not served"
# Status page, also without the trailing slash
status_page="$(curl -fsSL "http://127.0.0.1:$WEB_PORT/autotrim")" || fail "status page not reachable"
grep -q 'data-autotrim-page' <<< "$status_page" || fail "the status page isn't served at /autotrim/"
if grep -q 'UNIQUE_VERSION' <<< "$status_page"; then fail "UNIQUE_VERSION not replaced in the status page"; fi
status="$(autotrim_api GET status)" || fail "auto-trim API not reachable through nginx"
grep -q '"enabled":false' <<< "$status" || fail "auto-trim should be off by default: $status"
autotrim_pid="$(autotrim_pid)" || fail "auto-trim service not running"
autotrim_uid="$(docker exec "$NAME" awk '/^Uid:/{print $2}' "/proc/$autotrim_pid/status")"
autotrim_nice="$(docker exec "$NAME" awk '{print $19}' "/proc/$autotrim_pid/stat")"
echo "  uid: $autotrim_uid, niceness: $autotrim_nice"
[[ "$autotrim_uid" == 1000 && "$autotrim_nice" == 19 ]] || fail "auto-trim should run as uid 1000 with niceness 19"
# As if LosslessCut had just saved the project of '[0-3]edited.mp4': it waits
#  10 min after the last save
app_exec touch '/medias/auto/[0-3]edited-proj.llc'
autotrim_api POST enabled '{"enabled":true}' >/dev/null || fail "could not switch auto-trim on"
wait_for_file '/medias/auto/AUTO ONE-trimmed.mp4' 120 || fail "auto-trim didn't trim '[2-5,8-end]auto one.mp4'"
# AUTO TWO-trimmed.mp4 exists already: not overwritten
wait_for_file '/medias/auto/AUTO TWO-trimmed (2).mp4' 60 || fail "auto-trim didn't trim '[0-3]auto two.mp4' to 'AUTO TWO-trimmed (2).mp4'"
for output in '/medias/auto/AUTO ONE-trimmed.mp4:14.5:15.6' '/medias/auto/AUTO TWO-trimmed (2).mp4:2.5:4.5'; do
    IFS=: read -r file min max <<< "$output"
    duration="$(media_duration "$file")" || fail "trimmed file looks broken: $file"
    echo "  trimmed: $file (${duration}s)"
    between "$duration" "$min" "$max" || fail "unexpected duration ${duration}s for $file (expected $min-$max s)"
done
duration="$(media_duration '/medias/auto/AUTO TWO-trimmed.mp4')"
between "$duration" 19 21 || fail "the existing AUTO TWO-trimmed.mp4 was overwritten"
check_trashed '/medias/auto/[2-5,8-end]auto one.mp4'
check_trashed '/medias/auto/[0-3]auto two.mp4'
# The original's modified date, permissions and tags (also when merging)
for pair in 'AUTO ONE-trimmed.mp4:[2-5,8-end]auto one.mp4' 'AUTO TWO-trimmed (2).mp4:[0-3]auto two.mp4'; do
    IFS=: read -r output source <<< "$pair"
    output="/medias/auto/$output"
    # The trash keeps the source's modified date and permissions
    source="/medias/.Trash-1000/files/$source"
    expected="$(docker exec "$NAME" stat -c '%Y %a' "$source")" || fail "can't read $source"
    actual="$(docker exec "$NAME" stat -c '%Y %a' "$output")" || fail "can't read $output"
    echo "  $output: $(docker exec "$NAME" stat -c 'modified %y, mode %a' "$output")"
    [[ "$actual" == "$expected" && "${expected% *}" -lt 1600000000 ]] \
        || fail "$output: modified date and mode '$actual' instead of the original's '$expected'"
    tags="$(docker exec -e LD_LIBRARY_PATH=/LosslessCut/resources "$NAME" /LosslessCut/resources/ffprobe -v error \
        -show_entries format_tags=title,comment,creation_time -of default=nw=1 "$output")"
    echo "  tags: $(tr '\n' ' ' <<< "$tags")"
    for tag in 'TAG:title=Smoke title' 'TAG:comment=Keep me' 'TAG:creation_time=2020-01-02T03:04:05'; do
        grep -qF "$tag" <<< "$tags" || fail "$output: tag ${tag#TAG:} not kept"
    done
done
# Edited in LosslessCut: waiting, not trimmed
for _ in $(seq 1 30); do
    status="$(autotrim_api GET status)" || fail "auto-trim API not reachable"
    grep -qF '"name":"[0-3]edited.mp4","reason":"edited in LosslessCut"' <<< "$status" && break
    sleep 1
done
grep -qF '"name":"[0-3]edited.mp4","reason":"edited in LosslessCut"' <<< "$status" \
    || fail "'[0-3]edited.mp4' isn't listed as waiting, edited in LosslessCut: $status"
if ! docker exec "$NAME" test -e '/medias/auto/[0-3]edited.mp4' || docker exec "$NAME" test -e '/medias/auto/EDITED-trimmed.mp4'; then
    fail "'[0-3]edited.mp4' was trimmed while edited in LosslessCut"
fi
echo "  waiting, edited in LosslessCut: /medias/auto/[0-3]edited.mp4"
autotrim_logs="$(docker logs "$NAME" 2>&1 | grep '\[autotrim')" || fail "no auto-trim log"
while IFS= read -r line; do echo "  $line"; done <<< "$autotrim_logs"
# One at a time: each trim ends before the next one starts
concurrent="$(awk '/ trimming /{n++; if (n > m) m = n} / (done|failed|cancelled) /{n--} END {print m + 0}' <<< "$autotrim_logs")"
[[ "$concurrent" == 1 ]] || fail "$concurrent trims at the same time, expected 1"
if grep -q ' failed ' <<< "$autotrim_logs"; then fail "a background trim failed"; fi
# The status page's video picker: the top of /medias, its subfolders too
#  with subfolders=1
videos="$(autotrim_api GET 'videos?q=two-trimmed.mp4')" || fail "videos API not reachable"
grep -q '"total":0,' <<< "$videos" || fail "a video in a subfolder is listed without subfolders=1: $videos"
videos="$(autotrim_api GET 'videos?q=two-trimmed.mp4&subfolders=1')" || fail "videos API not reachable"
if ! grep -q '"total":1,' <<< "$videos" || ! grep -qF '"file":"/medias/auto/AUTO TWO-trimmed.mp4"' <<< "$videos"; then
    fail "the video in a subfolder isn't listed with subfolders=1: $videos"
fi
echo "  video picker: /medias/auto/AUTO TWO-trimmed.mp4 listed only with its subfolders"
if command -v node >/dev/null \
    && node -e "try { require.resolve('playwright-core') } catch { require.resolve('playwright') }" 2>/dev/null; then
    log "Checking the auto-trim views in a browser"
    # While '[0-3]edited.mp4' waits: status box, badge, side panel, status page.
    #  On the status page, 'AUTO TWO-trimmed.mp4' (in a subfolder: found with
    #  Include subfolders) is renamed with [2-5] after confirming, then
    #  'rename me.mp4' without confirmation
    node "$(dirname "$0")/ui-check.cjs" "http://127.0.0.1:$WEB_PORT/" "$OUT_DIR" on 'AUTO ONE-trimmed.mp4' '[0-3]edited.mp4' \
        'two-trimmed.mp4' '/medias/auto/AUTO TWO-trimmed.mp4' '2-5' 'AUTO TWO-trimmed[2-5].mp4' \
        'rename me' '/medias/rename me.mp4' 'rename me[2-5].mp4' \
        || fail "the auto-trim views don't work"
    log "Checking that the videos renamed on the status page are trimmed"
    for renamed in '/medias/auto/AUTO TWO-trimmed[2-5].mp4:/medias/auto/AUTO TWO-TRIMMED-trimmed.mp4' \
        '/medias/rename me[2-5].mp4:/medias/RENAME ME-trimmed.mp4'; do
        IFS=: read -r source output <<< "$renamed"
        wait_for_file "$output" 90 || fail "the renamed '$source' wasn't trimmed"
        duration="$(media_duration "$output")" || fail "trimmed file looks broken: $output"
        echo "  trimmed: $output (${duration}s)"
        between "$duration" 2.5 4.5 || fail "unexpected duration ${duration}s for $output (expected 2.5-4.5 s)"
        check_trashed "$source"
    done
else
    log "Auto-trim views not checked in a browser (needs node and playwright-core)"
fi
status="$(autotrim_api POST enabled '{"enabled":false}')" || fail "could not switch auto-trim off"
grep -q '"enabled":false' <<< "$status" || fail "auto-trim still on: $status"
grep -q '"waiting":\[\]' <<< "$status" || fail "videos still listed as waiting once switched off: $status"

log "Resource usage"
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}' "$NAME" \
    | tee "$OUT_DIR/stats.txt"

state="$(docker inspect -f '{{.State.Status}} {{.State.OOMKilled}} {{.RestartCount}}' "$NAME")"
[[ "$state" == "running false 0" ]] || fail "unexpected container state (status, OOM killed, restarts): $state"
# KEEP_APP_RUNNING would hide a crash, so make sure it's still the same process
[[ "$(main_pid)" == "$pid" ]] || fail "LosslessCut was restarted during the test"

# Notifications need HTTPS, which also puts VNC behind SSL (no screenshots),
#  hence a second container, with the image defaults and a new config
log "Checking notifications (second container, image defaults: HTTPS + WEB_NOTIFICATION)"
remove_container "$NAME"
NAME="$NOTIF_NAME"
start_container "$NOTIF_CLIP" -e CONTAINER_DEBUG=1
wait_healthy
WEB_PORT="$(docker port "$NAME" 5800/tcp 2>/dev/null | head -n 1 | sed 's/.*://')" || true
docker exec "$NAME" test -f /var/tmp/nginx/ssl.conf || fail "HTTPS isn't enabled by default"
wait_api
sleep 10
notified=
for attempt in 1 2 3; do
    api POST /api/action/export 180 >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
        # Logged by the base image's notification service (debug level)
        if log_has "new desktop notification received"; then
            notified=1
            break 2
        fi
        sleep 2
    done
    log "  no notification yet (attempt $attempt)"
done
[[ -n "$notified" ]] || fail "no desktop notification was sent after the export"
docker logs "$NAME" 2>&1 | grep "desktop notification" | sed 's/^/  /'

log "PASS"
