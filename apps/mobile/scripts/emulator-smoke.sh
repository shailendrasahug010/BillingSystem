#!/usr/bin/env bash
# Installs the APK on the running emulator and starts it: the web app must
# come up (it logs "digitalbahi: app ready" to the console, which Capacitor
# passes to Android's log) with no crash and no script error, on the screen
# that asks for the server.
set -uo pipefail
apk="$1"
adb install -r "$apk"
adb logcat -c
adb shell am start -W -n in.digitalbahi.app/.MainActivity
ready=""
for _ in $(seq 1 60); do
  if adb logcat -d | grep -q "digitalbahi: app ready"; then
    ready=1
    break
  fi
  sleep 2
done
sleep 3
adb logcat -d > logcat.txt
grep -E "Capacitor|AndroidRuntime|chromium" logcat.txt | tail -60
adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 && adb pull /sdcard/ui.xml ui.xml > /dev/null 2>&1
if [ -z "$ready" ]; then
  echo "::error::The app did not start: no 'digitalbahi: app ready' in the log"
  exit 1
fi
# Only this app's crashes and script errors count (the emulator's own apps log too).
if grep -A3 "FATAL EXCEPTION" logcat.txt | grep -q "Process: in.digitalbahi.app"; then
  grep -A30 "FATAL EXCEPTION" logcat.txt
  echo "::error::The app crashed at start"
  exit 1
fi
if grep "Capacitor/Console" logcat.txt | grep -E "Uncaught (Type|Reference|Syntax)Error"; then
  echo "::error::A script failed at start"
  exit 1
fi
if [ -f ui.xml ] && grep -q "Connect to your Digital Bahi" ui.xml; then
  echo "The first screen asks for the server."
else
  echo "::warning::The server screen was not found in the UI dump (the web view's text may not be in it)"
fi
echo "The app started."
