#!/usr/bin/env sh
# SessionEnd hook → .ddd/recap.md
#
# Deliberately thin: it forwards the hook payload to ddd-recap and always exits
# 0. A recap failing must never be able to make ending a session feel broken.
ddd-recap || true
exit 0
