#!/bin/sh
#
# Start LosslessCut. Runs as the unprivileged app user.
#
# Environment (see README):
#   LOSSLESSCUT_GPU                 auto (default), 1 or 0
#   LOSSLESSCUT_DISABLE_NETWORKING  1 (default) or 0
#   LOSSLESSCUT_DEFAULT_SETTINGS    1 (default) or 0
#   LOSSLESSCUT_ARGS                extra command line arguments
#

set -u # Treat unset variables as an error.

log() {
    echo "[startapp] $*"
}

# The GTK file chooser opens in the working directory
cd /storage 2>/dev/null || cd "$HOME" || cd /

# Save GTK settings (e.g. sort order and size of the file chooser) under
#  $XDG_CONFIG_HOME, they'd be forgotten on restart otherwise
export GSETTINGS_BACKEND="${GSETTINGS_BACKEND:-keyfile}"

# - Sandboxing needs user namespaces, which Docker blocks, the container is
#   the sandbox
# - Docker gives /dev/shm only 64MB by default, which Chromium can exhaust with
#   large videos. Use /tmp instead, so no --shm-size is needed
set -- --no-sandbox --disable-dev-shm-usage

RENDER_NODE=
for node in /dev/dri/renderD*; do
    if [ -c "$node" ]; then
        RENDER_NODE="$node"
        break
    fi
done
case "${LOSSLESSCUT_GPU:-auto}" in
    auto|AUTO|Auto)
        # Actually opening the device is the only reliable test, permissions
        #  alone don't account for the device cgroup
        if [ -n "$RENDER_NODE" ] && ( exec 3<>"$RENDER_NODE" ) 2>/dev/null; then
            USE_GPU=1
        else
            USE_GPU=0
        fi
        ;;
    *)
        if is-bool-val-true "${LOSSLESSCUT_GPU}"; then
            USE_GPU=1
        else
            USE_GPU=0
        fi
        ;;
esac

if [ "$USE_GPU" -eq 1 ]; then
    log "GPU enabled (render node: ${RENDER_NODE:-none})"
    # Hardware video decoding in the player
    set -- "$@" --enable-features=AcceleratedVideoDecodeLinuxGL
    # Let the bundled ffmpeg (VAAPI selected in LosslessCut's settings) find
    #  the system drivers
    if [ -z "${LIBVA_DRIVERS_PATH:-}" ]; then
        for d in /usr/lib/*-linux-gnu*/dri; do
            if [ -d "$d" ]; then
                export LIBVA_DRIVERS_PATH="$d"
                break
            fi
        done
    fi
else
    log "GPU disabled, using software rendering"
    # Without a GPU Chromium would emulate one on the CPU (SwiftShader), which
    #  is much more expensive than plain software compositing
    set -- "$@" --disable-gpu
fi

# Updates come with the image, there's no point in checking for them, and
#  there's no browser in the container to open links with
if is-bool-val-true "${LOSSLESSCUT_DISABLE_NETWORKING:-1}"; then
    set -- "$@" --disable-networking
fi

# Default settings of this image (output file names, cleanup after export),
#  only for the settings the user hasn't changed
DEFAULT_SETTINGS=/defaults/losslesscut-settings.json
if is-bool-val-true "${LOSSLESSCUT_DEFAULT_SETTINGS:-1}" && [ -f "$DEFAULT_SETTINGS" ]; then
    case " ${LOSSLESSCUT_ARGS:-} " in
        *" --settings-json"*)
            log "Default settings not applied: LOSSLESSCUT_ARGS has --settings-json"
            ;;
        *)
            # LosslessCut's Electron, as Node.js
            SETTINGS="$(ELECTRON_RUN_AS_NODE=1 /LosslessCut/losslesscut \
                /opt/losslesscut-tools/settings-defaults.cjs \
                "${XDG_CONFIG_HOME:-$HOME/.config}/LosslessCut/config.json" "$DEFAULT_SETTINGS")" \
                || SETTINGS=
            if [ -n "$SETTINGS" ] && [ "$SETTINGS" != "{}" ]; then
                log "Applying default settings: $SETTINGS"
                set -- "$@" "--settings-json=$SETTINGS"
            fi
            ;;
    esac
fi

# User arguments go first: LosslessCut's argument parser lets an unknown flag
#  (e.g. --disable-gpu) take the next word as its value, which would swallow
#  a file to open. Chromium doesn't care about the order.
# Word splitting is intended here, globbing isn't
set -f
# shellcheck disable=SC2086
set -- ${LOSSLESSCUT_ARGS:-} "$@"
set +f

log "Starting: /LosslessCut/losslesscut $*"
exec /LosslessCut/losslesscut "$@"
