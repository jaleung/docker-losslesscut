#!/bin/bash

# Smoke test for the LosslessCut image: start it with NAS-like resource limits,
#  check it's healthy, open a generated video and export a cut through
#  LosslessCut's HTTP API. Then, in a second container with HTTPS and
#  WEB_NOTIFICATION, check that the "Export finished" notification is sent.
#
# Usage: helper-scripts/smoke-test.sh [IMAGE]
#
# Environment:
#   OUT_DIR       where logs and screenshots are written (./smoke-test-output)
#   SMOKE_CPUS    CPU limit (3)
#   SMOKE_MEMORY  memory limit (2g)
#   SMOKE_TIMEOUT seconds to wait for the container to become healthy (300)
#
# Screenshots are taken if vncdo (pip install vncdotool) is available.

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
CLIP=/storage/smoke-test.mp4
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
    docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
    if [[ $rc -ne 0 ]]; then
        log "Last lines of the container log (full logs in $OUT_DIR):"
        tail -n 50 "$OUT_DIR/$NAME.log" 2>/dev/null || true
    fi
    exit $rc
}
trap cleanup EXIT

# Start $NAME with the test clip and the HTTP API
# Usage: start_container [DOCKER RUN ARGS...]
start_container() {
    docker run -d --name "$NAME" \
        --cpus "$SMOKE_CPUS" --memory "$SMOKE_MEMORY" \
        -v "$VOLUME:/storage" \
        -e LOSSLESSCUT_ARGS="--http-api $API_PORT --settings-json {exportConfirmEnabled:false} $CLIP" \
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
# Usage: api METHOD PATH [TIMEOUT]
api() {
    app_exec sh -c "printf '%s %s HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n' '$1' '$2' \
        | timeout ${3:-60} nc 127.0.0.1 $API_PORT"
}

# Main LosslessCut process (Electron's children have --type=...)
main_pid() {
    docker exec "$NAME" sh -c '
        for p in $(pidof losslesscut); do
            tr "\0" " " < /proc/$p/cmdline | grep -q -- "--type=" || { echo $p; exit 0; }
        done
        exit 1'
}

screenshot() {
    if command -v vncdo >/dev/null; then
        vncdo -s "127.0.0.1::$VNC_PORT" --delay 0 "$@" || log "WARNING: screenshot failed"
    fi
}

log "Image: $IMAGE"

log "Generating a test clip"
docker volume create "$VOLUME" >/dev/null
docker run --rm -v "$VOLUME:/storage" --entrypoint sh "$IMAGE" -c "
    LD_LIBRARY_PATH=/LosslessCut/resources /LosslessCut/resources/ffmpeg -hide_banner -loglevel error \
        -f lavfi -i testsrc2=size=1280x720:rate=25 -f lavfi -i sine=frequency=440 \
        -t 20 -g 50 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest -y $CLIP \
    && chown -R 1000:1000 /storage"

log "Starting the container (cpus=$SMOKE_CPUS, memory=$SMOKE_MEMORY)"
start_container -p 127.0.0.1::5800 -p 127.0.0.1::5900 -e DISPLAY_WIDTH=1280 -e DISPLAY_HEIGHT=720

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

wait_api
# Give the file some time to load
sleep 10
screenshot capture "$OUT_DIR/01-file-opened.png"

log "Exporting through the HTTP API"
exported=
for attempt in 1 2 3; do
    api POST /api/action/export 180 > "$OUT_DIR/export-response.txt" 2>&1 || true
    for _ in $(seq 1 30); do
        exported="$(docker exec "$NAME" sh -c "ls /storage | grep -v -e '^smoke-test.mp4$' -e '\.llc$' | head -n 1")" || true
        [[ -n "$exported" ]] && break 2
        sleep 2
    done
    log "  no output yet (attempt $attempt)"
done
[[ -n "$exported" ]] || fail "export produced no file, see $OUT_DIR"
echo "  exported: /storage/$exported"
# The file might still be being written
duration=
for _ in $(seq 1 30); do
    duration="$(docker exec -e LD_LIBRARY_PATH=/LosslessCut/resources "$NAME" /LosslessCut/resources/ffprobe \
        -v error -show_entries format=duration -of default=nw=1:nk=1 "/storage/$exported" 2>/dev/null)" || true
    awk -v d="${duration:-0}" 'BEGIN { exit !(d > 1) }' && break
    sleep 2
done
echo "  duration: ${duration}s"
awk -v d="${duration:-0}" 'BEGIN { exit !(d > 1) }' || fail "exported file looks broken (duration: ${duration:-unknown})"
screenshot capture "$OUT_DIR/02-exported.png"

if command -v vncdo >/dev/null; then
    log "Checking the file dialog"
    api POST /api/action/openFilesDialog 10 >/dev/null 2>&1 || fail "could not open the file dialog"
    sleep 5
    # Typing in the dialog searches the current folder. Closing it can take
    #  several Esc while searching
    screenshot capture "$OUT_DIR/03-open-dialog.png" \
        type smoke pause 3 capture "$OUT_DIR/04-dialog-search.png" \
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

log "Resource usage"
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}' "$NAME" \
    | tee "$OUT_DIR/stats.txt"

state="$(docker inspect -f '{{.State.Status}} {{.State.OOMKilled}} {{.RestartCount}}' "$NAME")"
[[ "$state" == "running false 0" ]] || fail "unexpected container state (status, OOM killed, restarts): $state"
# KEEP_APP_RUNNING would hide a crash, so make sure it's still the same process
[[ "$(main_pid)" == "$pid" ]] || fail "LosslessCut was restarted during the test"

# Notifications need HTTPS, which also puts VNC behind SSL (no screenshots),
#  hence a second container
log "Checking notifications (second container, HTTPS + WEB_NOTIFICATION)"
remove_container "$NAME"
NAME="$NOTIF_NAME"
start_container -e SECURE_CONNECTION=1 -e WEB_NOTIFICATION=1 -e CONTAINER_DEBUG=1
wait_healthy
wait_api
sleep 10
notified=
for attempt in 1 2 3; do
    api POST /api/action/export 180 >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
        # Logged by the base image's notification service (debug level)
        if docker logs "$NAME" 2>&1 | grep -q "new desktop notification received"; then
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
