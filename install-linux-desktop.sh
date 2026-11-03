#!/usr/bin/env bash
# ==============================================================================
# Instalador de Launcher de Escritorio para Linux (Ubuntu / Debian)
# ==============================================================================
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chmod +x "$APP_DIR/rur-launcher.sh"
chmod +x "$APP_DIR/scripts/"*.sh 2>/dev/null || true

DESKTOP_FILE="$APP_DIR/rur-control-center.desktop"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Centro de Control RUR
Comment=Estación de Recepción ROS 2 y Telemetría LiveKit — RUR UNIPOLI
Exec=$APP_DIR/rur-launcher.sh
Path=$APP_DIR
Icon=$APP_DIR/public/assets/isotipo.png
Terminal=false
Categories=Development;Science;Robotics;Utility;
StartupNotify=true
EOF

chmod +x "$DESKTOP_FILE"
mkdir -p "$HOME/.local/share/applications"
cp "$DESKTOP_FILE" "$HOME/.local/share/applications/rur-control-center.desktop"

if [ -d "$HOME/Desktop" ]; then
  cp "$DESKTOP_FILE" "$HOME/Desktop/rur-control-center.desktop"
  chmod +x "$HOME/Desktop/rur-control-center.desktop"
elif [ -d "$HOME/Escritorio" ]; then
  cp "$DESKTOP_FILE" "$HOME/Escritorio/rur-control-center.desktop"
  chmod +x "$HOME/Escritorio/rur-control-center.desktop"
fi

echo "Launcher de Linux instalado en el menú de aplicaciones y Escritorio."
