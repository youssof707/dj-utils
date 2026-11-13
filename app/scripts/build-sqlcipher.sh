#!/bin/sh
# Builds resources/sqlcipher: the command-line SQLite that can open Rekordbox's encrypted
# database, which the app uses to write cue points. Uses macOS's own crypto, so the binary
# needs nothing beyond the system libraries.
#
#   sh scripts/build-sqlcipher.sh
set -eu

VERSION=v4.6.1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git clone --quiet --depth 1 --branch "$VERSION" https://github.com/sqlcipher/sqlcipher.git "$WORK/src"
cd "$WORK/src"
./configure --quiet --disable-shared --enable-static --disable-tcl --disable-readline --enable-tempstore=yes \
	--with-crypto-lib=commoncrypto \
	CFLAGS="-arch arm64 -mmacosx-version-min=11.0 -Os -DSQLITE_HAS_CODEC -DSQLCIPHER_CRYPTO_CC -DSQLITE_ENABLE_JSON1 -DSQLITE_THREADSAFE=1" \
	LDFLAGS="-arch arm64 -framework Security -framework CoreFoundation"
make --quiet sqlcipher

mkdir -p "$HERE/resources"
cp sqlcipher "$HERE/resources/sqlcipher"
strip "$HERE/resources/sqlcipher"
codesign --force --sign - "$HERE/resources/sqlcipher"
otool -L "$HERE/resources/sqlcipher"
"$HERE/resources/sqlcipher" -version
