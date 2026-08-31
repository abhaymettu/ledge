#!/bin/sh
# Build, sign, upload a new TestFlight build. Reads the team ID from
# ~/.ledge/config.json and App Store Connect API IDs from ~/.ledge/asc.json
# ({"keyId": "...", "issuerId": "..."}), both gitignored. Bumps
# CURRENT_PROJECT_VERSION so Apple accepts the build.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mktemp -d)
TEAM=$(node -e 'const c=require(process.env.HOME+"/.ledge/config.json");console.log(c.teamId)')
KEY=$(node -e 'const c=require(process.env.HOME+"/.ledge/asc.json");console.log(c.keyId)')
ISS=$(node -e 'const c=require(process.env.HOME+"/.ledge/asc.json");console.log(c.issuerId)')
PBX="$ROOT/ios/Ledge.xcodeproj/project.pbxproj"
CUR=$(grep -m1 -o 'CURRENT_PROJECT_VERSION = [0-9]*' "$PBX" | grep -o '[0-9]*')
NEXT=$((CUR + 1))
sed -i '' "s/CURRENT_PROJECT_VERSION = $CUR;/CURRENT_PROJECT_VERSION = $NEXT;/g" "$PBX"
echo "build $CUR -> $NEXT"
cat > "$OUT/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM</string>
  <key>uploadSymbols</key><true/>
  <key>signingStyle</key><string>automatic</string>
  <key>destination</key><string>export</string>
</dict></plist>
PLIST
cd "$ROOT/ios"
xcodebuild -project Ledge.xcodeproj -scheme Ledge -destination 'generic/platform=iOS' \
  -archivePath "$OUT/Ledge.xcarchive" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" archive
xcodebuild -exportArchive -archivePath "$OUT/Ledge.xcarchive" -exportPath "$OUT/export" \
  -exportOptionsPlist "$OUT/export.plist" -allowProvisioningUpdates
# altool exits 0 even when Apple rejects the package (409 upload-limit, bad entitlements),
# so its status is not the truth. Read the log, or the script announces a build that never
# left the Mac and leaves the version bumped past it. Cost build 24 on 2026-08-30.
xcrun altool --upload-app -f "$OUT/export/Ledge.ipa" -t ios --apiKey "$KEY" --apiIssuer "$ISS" 2>&1 | tee "$OUT/upload.log"
if grep -q "UPLOAD FAILED" "$OUT/upload.log"; then
  sed -i '' "s/CURRENT_PROJECT_VERSION = $NEXT;/CURRENT_PROJECT_VERSION = $CUR;/g" "$PBX"
  echo "upload rejected (see the error above); version rolled back to $CUR" >&2
  exit 1
fi
echo "uploaded build $NEXT, waiting for Apple to process it"

# Wait for Apple to process it, then hand it to the Internal group so it shows up in
# TestFlight without a trip to App Store Connect. Gives up after 10 minutes.
i=0
while [ $i -lt 60 ]; do
  ID=$(node "$ROOT/scripts/asc.mjs" builds | awk -v v="$NEXT" '$3 == v && $4 == "VALID" {print $1; exit}')
  [ -n "$ID" ] && break
  i=$((i + 1)); sleep 10
done
if [ -n "$ID" ]; then
  node "$ROOT/scripts/asc.mjs" assign "$ID" && echo "build $NEXT assigned to the Internal group; it is in TestFlight now."
else
  echo "build $NEXT is still processing. Assign it later: node scripts/asc.mjs builds, then node scripts/asc.mjs assign <id>"
fi
