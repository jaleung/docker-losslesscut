# syntax=docker/dockerfile:1
# See https://github.com/jlesage/docker-baseimage-gui

ARG app_version="3.69.0"
# Bump if publishing a new image with the same app_version, reset to 1 with new app versions
ARG image_revision="2"
# Pinned for reproducible builds, see https://hub.docker.com/r/jlesage/baseimage-gui/tags
ARG baseimage="jlesage/baseimage-gui:debian-13-v4.14.0"
# BUILDPLATFORM and TARGETPLATFORM are defined when using BuildKit (i.e. docker buildx)
# Do NOT define a default value or it will override what BuildKit sets
# Do NOT declare TARGETPLATFORM as an ARG before FROM either or it becomes empty
#ARG TARGETPLATFORM

FROM ${baseimage} AS extract-stage
ARG TARGETPLATFORM
ARG app_version
ARG download_url_template="https://github.com/mifi/lossless-cut/releases/download/v${app_version}/LosslessCut-linux-#ARCH#.tar.bz2"

# Deduce LosslessCut architecture suffix based on TARGETPLATFORM
# The LC_ALL is an attempt to prevent apt complaining about the locale
# chrome-sandbox and app-update.yml are removed since they're not used in the
#  container: there's no SUID sandbox and updates come with the image
RUN set -eu \
    && case "${TARGETPLATFORM:?TARGETPLATFORM must be set, build with BuildKit}" in \
        linux/amd64) arch=x64 ;; \
        linux/arm64) arch=arm64 ;; \
        linux/arm/v7) arch=armv7l ;; \
        *) echo "Unsupported platform: ${TARGETPLATFORM}" >&2 ; exit 1 ;; \
    esac \
    && LC_ALL=C add-pkg ca-certificates bzip2 wget \
    && wget --progress=dot:giga -O /app.tbz "$(echo "${download_url_template}" | sed "s/#ARCH#/${arch}/")" \
    && tar -C / -xjf /app.tbz \
    && mv /LosslessCut-linux-*/ /LosslessCut \
    && rm -f /LosslessCut/chrome-sandbox /LosslessCut/resources/app-update.yml

FROM ${baseimage} AS final-stage
ARG TARGETPLATFORM
ARG app_version
ARG image_revision
ARG app_icon="https://raw.githubusercontent.com/mifi/lossless-cut/v${app_version}/src/renderer/src/icon.svg"

# Runtime libraries for Electron. Only top-level packages are listed, the rest
#  are pulled as dependencies. The build fails below if anything is missing.
#  See the helper script 'generate_dependencies_list.bash'
# - libpulse0: audio via WEB_AUDIO (dlopen'ed, invisible to ldd)
# - libgl1, libegl1: GL when the GPU is enabled (dlopen'ed by ANGLE)
RUN LC_ALL=C.UTF-8 add-pkg \
      libasound2t64 \
      libcups2t64 \
      libdrm2 \
      libegl1 \
      libgbm1 \
      libgl1 \
      libgtk-3-0t64 \
      libnss3 \
      libpulse0 \
      libx11-xcb1 \
      libxkbcommon0

# VAAPI drivers for hardware decoding when /dev/dri is passed to the container
#  (intel-media/i965: Intel iGPUs such as the ones in most x86 QNAP NAS, mesa: AMD)
#  vainfo is included to diagnose the setup
RUN if [ "${TARGETPLATFORM}" = linux/amd64 ]; then \
        LC_ALL=C.UTF-8 add-pkg \
            i965-va-driver \
            intel-media-va-driver \
            mesa-va-drivers \
            vainfo ; \
    fi

COPY --from=extract-stage /LosslessCut /LosslessCut

# Workaround for LosslessCut on arm not containing ffmpeg
RUN test -x /LosslessCut/resources/ffmpeg \
    || ( LC_ALL=C.UTF-8 add-pkg ffmpeg \
        && ln -s /usr/bin/ffmpeg /usr/bin/ffprobe /LosslessCut/resources/ \
    )

# Fail the build if any shared library is missing, and make sure ffmpeg runs
RUN set -eu \
    && export LD_LIBRARY_PATH=/LosslessCut/resources \
    && for bin in /LosslessCut/losslesscut /LosslessCut/resources/ffmpeg /LosslessCut/resources/ffprobe; do \
        if ldd "$bin" | grep 'not found'; then \
            echo "Missing libraries for $bin" >&2 ; exit 1 ; \
        fi ; \
    done \
    && /LosslessCut/resources/ffmpeg -hide_banner -version | head -n 1 \
    && /LosslessCut/resources/ffprobe -hide_banner -version | head -n 1

COPY rootfs/ /

# Make the GTK file chooser open in the working directory (/storage) instead of
#  "Recent", see rootfs/usr/share/glib-2.0/schemas/
RUN LC_ALL=C.UTF-8 add-pkg --virtual build-schemas libglib2.0-bin \
    && glib-compile-schemas /usr/share/glib-2.0/schemas \
    && del-pkg build-schemas \
    && mkdir -p /storage \
    && chmod 0755 /startapp.sh /etc/cont-init.d/55-losslesscut.sh

# Set app name, version and generate favicons
# The icon is only available as SVG, which ImageMagick can't read by itself
RUN set-cont-env APP_NAME "LosslessCut" \
    && set-cont-env APP_VERSION "${app_version}" \
    && set-cont-env DOCKER_IMAGE_VERSION "${image_revision}" \
    && LC_ALL=C.UTF-8 add-pkg --virtual build-icon ca-certificates curl librsvg2-bin \
    && curl -sS -L -f -o /tmp/icon.svg "${app_icon}" \
    && rsvg-convert -w 512 -h 512 -o /tmp/icon.png /tmp/icon.svg \
    && install_app_icon.sh /tmp/icon.png \
    && del-pkg build-icon \
    && rm -f /tmp/icon.svg /tmp/icon.png

# Defaults tuned for small, shared hosts such as a NAS:
# - APP_NICENESS: lower priority than the host services (and ffmpeg inherits it)
# - KEEP_APP_RUNNING: restart LosslessCut if it crashes or is OOM-killed
# - LOSSLESSCUT_*: see rootfs/startapp.sh and README
ENV \
    APP_NICENESS=10 \
    KEEP_APP_RUNNING=1 \
    LOSSLESSCUT_GPU=auto \
    LOSSLESSCUT_DISABLE_NETWORKING=1 \
    LOSSLESSCUT_ARGS=

# /storage is intentionally not a VOLUME to avoid creating anonymous volumes
#  every time the container is recreated without it being mapped
VOLUME ["/config"]

# 5800: Web, 5900: VNC
EXPOSE 5800/tcp 5900/tcp

# Note the org.label-schema.* labels are inherited from the base image
LABEL \
      maintainer="Toni Corvera <outlyer@gmail.com>" \
      org.opencontainers.image.title="Dockerized LosslessCut" \
      org.opencontainers.image.description="Docker container to make LosslessCut usable via web browser and VNC" \
      org.opencontainers.image.version="${app_version}-v${image_revision}" \
      org.opencontainers.image.url="https://github.com/jaleung/docker-losslesscut" \
      org.opencontainers.image.source="https://github.com/jaleung/docker-losslesscut" \
      org.opencontainers.image.licenses="GPL-2.0"

# Slow CPUs (e.g. NAS) need a while to bring up Electron
#  (WEB_LISTENING_PORT=-1 disables the web UI)
# --start-interval: check often while starting, so it's reported healthy soon
#  (ignored by Docker < 25)
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --start-interval=10s --retries=3 CMD \
    pidof losslesscut >/dev/null \
    && { [ "${WEB_LISTENING_PORT:-5800}" = "-1" ] || nc -z 127.0.0.1 "${WEB_LISTENING_PORT:-5800}" ; }
