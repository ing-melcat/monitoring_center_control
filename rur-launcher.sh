#!/usr/bin/env bash
# ==============================================================================
# RUR — Centro de Control (Launcher Nativo para Linux / Ubuntu ROS 2)
# ==============================================================================
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

# Cargar entorno ROS 2 si existe (Jazzy, Humble, Iron o Rolling)
for ROS_SETUP in /opt/ros/jazzy/setup.bash /opt/ros/humble/setup.bash /opt/ros/iron/setup.bash /opt/ros/rolling/setup.bash; do
  if [ -f "$ROS_SETUP" ]; then
    # shellcheck disable=SC1090
    source "$ROS_SETUP"
    break
  fi
done

export ROS_DOMAIN_ID=42
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export PYTHONUNBUFFERED=1

# Instalar dependencias si faltan
if [ ! -d "$APP_DIR/node_modules" ]; then
  echo "[INFO] Instalando módulos npm..."
  npm install
fi

STARTED_BY_LAUNCHER=0
if ! ss -tln 2>/dev/null | grep -q ":3000 " && ! nc -z 127.0.0.1 3000 2>/dev/null; then
  node "$APP_DIR/server.js" >/tmp/rur-control-center.log 2>&1 &
  SERVER_PID=$!
  STARTED_BY_LAUNCHER=1
  sleep 0.8
fi

cleanup() {
  if [ "$STARTED_BY_LAUNCHER" -eq 1 ] && [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

URL="http://127.0.0.1:3000"

if command -v google-chrome >/dev/null 2>&1; then
  google-chrome --app="$URL" --window-size=1440,900
elif command -v chromium-browser >/dev/null 2>&1; then
  chromium-browser --app="$URL" --window-size=1440,900
elif command -v chromium >/dev/null 2>&1; then
  chromium --app="$URL" --window-size=1440,900
elif command -v microsoft-edge >/dev/null 2>&1; then
  microsoft-edge --app="$URL" --window-size=1440,900
elif command -v brave-browser >/dev/null 2>&1; then
  brave-browser --app="$URL" --window-size=1440,900
else
  xdg-open "$URL"
  if [ -n "${SERVER_PID:-}" ]; then
    wait "$SERVER_PID"
  fi
fi
