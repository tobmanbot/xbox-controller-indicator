#!/usr/bin/env bash
# Installiert die Extension lokal für den aktuellen Benutzer
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ID="xbox-controller-indicator@tobmanbot"
DEST="$HOME/.local/share/gnome-shell/extensions/$EXT_ID"
SCHEMA_DIR="$DEST/schemas"
LOCALE_DIR="$DEST/locale"

echo "→ Installiere Extension nach $DEST"
rm -rf "$DEST"
mkdir -p "$SCHEMA_DIR" "$LOCALE_DIR"

# Dateien kopieren
cp "$SCRIPT_DIR/metadata.json" "$SCRIPT_DIR/extension.js" "$SCRIPT_DIR/prefs.js" "$DEST/"
cp "$SCRIPT_DIR/schemas/"*.gschema.xml "$SCHEMA_DIR/"

# Übersetzungen kopieren (.mo Dateien)
if [ -d "$SCRIPT_DIR/locale" ]; then
    cp -r "$SCRIPT_DIR/locale/"* "$LOCALE_DIR/"
    echo "→ Übersetzungen installiert"
fi

# Schema kompilieren
echo "→ Kompiliere GSettings-Schema"
glib-compile-schemas "$SCHEMA_DIR"

echo ""
echo "✓ Installation abgeschlossen."
echo ""
echo "Nächste Schritte:"
echo "  1. GNOME Shell neu starten: abmelden und neu anmelden (Wayland)"
echo "  2. Extension aktivieren:    gnome-extensions enable $EXT_ID"
echo "  3. Einstellungen öffnen:    gnome-extensions prefs $EXT_ID"
echo ""
echo "Bluetooth-MAC findest du mit:"
echo "  bluetoothctl devices"
