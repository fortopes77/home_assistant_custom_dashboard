#!/bin/sh
# Download one dashboard build from GitHub into /config/www/dashboard/.
# Usage: update_dashboard.sh OWNER/REPO COMMIT
set -eu
repo="$1"
sha="$2"
dir=/config/www/dashboard
base="https://raw.githubusercontent.com/$repo/$sha"
# Fetch to temporary files first so a failed download never leaves a broken dashboard.
curl -fsSL -o "$dir/index.html.new" "$base/index.html"
curl -fsSL -o "$dir/version.json.new" "$base/version.json"
mv "$dir/index.html.new" "$dir/index.html"
mv "$dir/version.json.new" "$dir/version.json"
echo "Installed $sha"
