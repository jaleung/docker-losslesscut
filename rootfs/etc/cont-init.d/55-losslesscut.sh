#!/bin/sh
#
# Prepare the environment of LosslessCut.
#

set -e # Exit immediately if a command exits with a non-zero status.
set -u # Treat unset variables as an error.

# Create a directory, and its missing parents, owned by the app user.
# Ownership of /config is normally taken later on anyway, but that can be
#  disabled with TAKE_CONFIG_OWNERSHIP=0.
mkdir_app() {
    [ -d "$1" ] && return 0
    mkdir_app "$(dirname "$1")"
    mkdir "$1"
    chown "$USER_ID:$GROUP_ID" "$1"
}

# Add /storage to the sidebar of the GTK file chooser.
# Only done once, so that user changes are kept.
BOOKMARKS="${XDG_CONFIG_HOME:-/config/xdg/config}/gtk-3.0/bookmarks"
if [ ! -f "$BOOKMARKS" ]; then
    mkdir_app "$(dirname "$BOOKMARKS")"
    echo "file:///storage Storage" > "$BOOKMARKS"
    chown "$USER_ID:$GROUP_ID" "$BOOKMARKS"
fi

# vim:ft=sh:ts=4:sw=4:et:sts=4
