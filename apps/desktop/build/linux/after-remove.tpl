#!/bin/bash
set -e

case "$1" in
    remove|purge)
        if type update-alternatives >/dev/null 2>&1; then

            update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}' || true
        elif [ -L '/usr/bin/${executable}' ] && [ "$(readlink '/usr/bin/${executable}')" = '/opt/${sanitizedProductName}/${executable}' ]; then
            rm -f '/usr/bin/${executable}'
        fi
        ;;
esac
