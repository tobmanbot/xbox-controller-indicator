/**
 * Xbox Controller Indicator – GNOME Shell Extension
 * Shows connected Bluetooth gamepad controllers as colored icons in the panel.
 *
 * Requires GNOME Shell 46+  (ESM / GJS 1.78+)
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Promisify D-Bus async methods for use with async/await (GJS 1.78+ / GNOME 46+)
Gio._promisify(Gio.DBusProxy, 'new_for_bus', 'new_for_bus_finish');
Gio._promisify(Gio.DBusProxy.prototype, 'call', 'call_finish');

// --- BlueZ D-Bus constants ---------------------------------------------------
const BLUEZ_BUS      = 'org.bluez';
const BLUEZ_PATH     = '/';
const DBUS_OM_IFACE  = 'org.freedesktop.DBus.ObjectManager';
const BLUEZ_DEVICE   = 'org.bluez.Device1';
const BLUEZ_BATTERY  = 'org.bluez.Battery1';

const GAMEPAD_KEYWORDS   = ['xbox', 'controller', 'gamepad', 'joystick', 'wireless'];
const GAMEPAD_APPEARANCE = 0x03C4;

// --- SVG icon helpers --------------------------------------------------------

function luminance(hex) {
    if (!hex || hex.length < 7) return 1;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function makeControllerSVG(color, size) {
    color = color || '#ffffff';
    size  = size  || 16;
    const dark = luminance(color) < 0.15;
    const filterDef = dark
        ? `<defs><filter id="glow" x="-40%" y="-40%" width="180%" height="180%">` +
          `<feDropShadow dx="0" dy="0" stdDeviation="2.5" flood-color="#ffffff" flood-opacity="0.85"/>` +
          `</filter></defs>`
        : '';
    const fa = dark ? ' filter="url(#glow)"' : '';
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">` +
        filterDef +
        `<path fill="${color}"${fa} d="` +
        `M16 20 C6 20 2 30 2 38 C2 50 10 58 20 54 L26 44 H38 L44 54 ` +
        `C54 58 62 50 62 38 C62 30 58 20 48 20 Z ` +
        `M22 32 H18 V28 H14 V32 H10 V36 H14 V40 H18 V36 H22 Z ` +
        `M46 30 C47.1 30 48 30.9 48 32 C48 33.1 47.1 34 46 34 ` +
        `C44.9 34 44 33.1 44 32 C44 30.9 44.9 30 46 30 Z ` +
        `M52 36 C53.1 36 54 36.9 54 38 C54 39.1 53.1 40 52 40 ` +
        `C50.9 40 50 39.1 50 38 C50 36.9 50.9 36 52 36 Z ` +
        `M40 36 C41.1 36 42 36.9 42 38 C42 39.1 41.1 40 40 40 ` +
        `C38.9 40 38 39.1 38 38 C38 36.9 38.9 36 40 36 Z ` +
        `M46 42 C47.1 42 48 42.9 48 44 C48 45.1 47.1 46 46 46 ` +
        `C44.9 46 44 45.1 44 44 C44 42.9 44.9 42 46 42 Z"/></svg>`
    );
}

/** Battery percentage emoji bar */
function batteryBar(pct) {
    if (pct >= 90) return '🔋 ' + pct + '%';
    if (pct >= 60) return '🔋 ' + pct + '%';
    if (pct >= 30) return '🪫 ' + pct + '%';
    return '🪫 ' + pct + '% ⚠️';
}

// --- Per-controller panel button ---------------------------------------------
const ControllerButton = GObject.registerClass(
class ControllerButton extends PanelMenu.Button {
    _init(device, color, name, iconSize, dbusPath, showBattery) {
        super._init(0.0, `Controller: ${name}`);
        this._device      = device;
        this._color       = color;
        this._name        = name;
        this._iconSize    = iconSize;
        this._dbusPath    = dbusPath;
        this._showBattery = showBattery;
        this._mac         = null;  // set by caller

        const svgBytes = GLib.Bytes.new(
            new TextEncoder().encode(makeControllerSVG(color, iconSize))
        );

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        try {
            box.add_child(new St.Icon({
                style_class: 'system-status-icon',
                icon_size: iconSize,
                gicon: Gio.BytesIcon.new(svgBytes),
            }));
        } catch (_) {
            box.add_child(new St.Label({
                text: '\u{1F3AE}',
                y_align: Clutter.ActorAlign.CENTER,
                style: `color: ${color};`,
            }));
        }

        this.add_child(box);
        this._buildMenu();
    }

    _buildMenu() {
        // Header: controller name
        this.menu.addMenuItem(
            new PopupMenu.PopupMenuItem(this._name, {reactive: false})
        );

        // Battery item (only if enabled)
        if (this._showBattery) {
            this._batteryItem = new PopupMenu.PopupMenuItem('🔋 …', {reactive: false});
            this.menu.addMenuItem(this._batteryItem);

            // Refresh battery when menu opens
            this._openId = this.menu.connect('open-state-changed', (menu, open) => {
                if (open) this._refreshBattery();
            });
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const disconnectItem = new PopupMenu.PopupMenuItem(_('Disconnect'));
        disconnectItem.connect('activate', () => this._disconnect());
        this.menu.addMenuItem(disconnectItem);
    }

    async _refreshBattery() {
        if (!this._batteryItem) return;
        try {
            const proxy = await Gio.DBusProxy.new_for_bus(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START | Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS,
                null,
                BLUEZ_BUS, this._dbusPath, BLUEZ_BATTERY,
                null
            );
            const pctVar = proxy.get_cached_property('Percentage');
            if (pctVar) {
                this._batteryItem.label.set_text(batteryBar(pctVar.unpack()));
            } else {
                this._batteryItem.label.set_text(_('Battery: not available'));
            }
        } catch (_) {
            if (this._batteryItem)
                this._batteryItem.label.set_text(_('Battery: not available'));
        }
    }

    _disconnect() {
        this.menu.close();
        this._device.call('Disconnect', null, Gio.DBusCallFlags.NONE, -1, null,
            (proxy, res) => {
                try { proxy.call_finish(res); }
                catch (e) {
                    Main.notify(`Controller ${this._name}`,
                        `Disconnect failed: ${e.message}`);
                }
            }
        );
    }

    destroy() {
        if (this._openId) {
            this.menu.disconnect(this._openId);
            this._openId = null;
        }
        super.destroy();
    }
});

// --- Main Extension ----------------------------------------------------------
export default class XboxControllerIndicator extends Extension {

    enable() {
        this._settings  = this.getSettings();
        this._buttons   = new Map();  // objectPath -> ControllerButton
        this._proxies   = new Map();  // objectPath -> { proxy, mac, name, sigId }
        this._macToPath = new Map();  // MAC -> objectPath

        this._settingsChangedId = this._settings.connect(
            'changed::controller-colors',
            () => this._onSettingsChanged()
        );
        this._batterySettingId = this._settings.connect(
            'changed::show-battery',
            () => this._onSettingsChanged()
        );

        this._startWatching();
    }

    disable() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._batterySettingId) {
            this._settings.disconnect(this._batterySettingId);
            this._batterySettingId = null;
        }
        this._stopWatching();

        for (const entry of this._proxies.values()) {
            if (entry.sigId) entry.proxy.disconnect(entry.sigId);
        }
        for (const btn of this._buttons.values()) btn.destroy();

        this._buttons.clear();
        this._proxies.clear();
        this._macToPath.clear();
        this._settings = null;
    }

    // -- Settings change -> live update ---------------------------------------

    _onSettingsChanged() {
        const colorMap    = this._getColorMap();
        const showBattery = this._settings.get_boolean('show-battery');

        // 1. Recreate existing buttons
        for (const [path, btn] of [...this._buttons.entries()]) {
            const mac = btn._mac;
            if (!mac || !colorMap[mac]) continue;
            const cfg   = colorMap[mac];
            const entry = this._proxies.get(path);
            if (!entry) continue;

            btn.destroy();
            this._buttons.delete(path);

            const newBtn = new ControllerButton(
                entry.proxy, cfg.color, cfg.name || entry.name,
                this._getIconSize(), path, showBattery
            );
            newBtn._mac = mac;
            this._buttons.set(path, newBtn);
            Main.panel.addToStatusArea(`xbox-ctrl-${path}`, newBtn);
        }

        // 2. Show buttons for already-connected but previously unconfigured
        for (const [path, entry] of this._proxies.entries()) {
            if (this._buttons.has(path)) continue;
            if (!colorMap[entry.mac]) continue;
            try {
                const connVar = entry.proxy.get_cached_property('Connected');
                if (!connVar || !connVar.unpack()) continue;
            } catch (_) { continue; }
            this._showButton(path, entry, colorMap[entry.mac]);
        }
    }

    // -- Settings helpers -----------------------------------------------------

    _getColorMap() {
        const map = {};
        for (const entry of this._settings.get_strv('controller-colors')) {
            const parts = entry.split(':');
            if (parts.length < 7) continue;
            const mac   = parts.slice(0, 6).join(':').toUpperCase();
            const color = parts[6];
            const name  = parts.slice(7).join(':');
            map[mac] = {color, name};
        }
        return map;
    }

    _getIconSize() {
        return this._settings.get_int('icon-size') || 16;
    }

    // -- BlueZ watching -------------------------------------------------------

    async _startWatching() {
        try {
            this._omProxy = await Gio.DBusProxy.new_for_bus(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.NONE,
                null,
                BLUEZ_BUS, BLUEZ_PATH, DBUS_OM_IFACE,
                null
            );
        } catch (e) {
            console.error('[xbox-controller-indicator] ObjectManager failed:', e);
            return;
        }

        this._addedId = this._omProxy.connectSignal(
            'InterfacesAdded',
            (proxy, sender, [path, ifaces]) => this._onDeviceAdded(path, ifaces)
        );
        this._removedId = this._omProxy.connectSignal(
            'InterfacesRemoved',
            (proxy, sender, [path, ifaces]) => this._onDeviceRemoved(path, ifaces)
        );

        try {
            const result = await this._omProxy.call(
                'GetManagedObjects', null, Gio.DBusCallFlags.NONE, -1, null
            );
            const [objs] = result.deep_unpack();
            for (const [path, ifaces] of Object.entries(objs))
                this._trackDevice(path, ifaces);
        } catch (e) {
            console.error('[xbox-controller-indicator] GetManagedObjects:', e);
        }
    }

    _stopWatching() {
        if (this._omProxy) {
            if (this._addedId)   this._omProxy.disconnectSignal(this._addedId);
            if (this._removedId) this._omProxy.disconnectSignal(this._removedId);
            this._omProxy = null;
        }
    }

    // -- Device tracking ------------------------------------------------------

    async _trackDevice(path, ifaces) {
        const dev = ifaces[BLUEZ_DEVICE];
        if (!dev) return;

        const paired = dev['Paired']?.unpack?.() ?? dev['Paired'];
        if (!paired) return;

        const mac  = (dev['Address']?.unpack?.() ?? dev['Address'] ?? '').toUpperCase();
        const name = dev['Name']?.unpack?.()     ?? dev['Name']    ?? mac;
        if (!mac) return;

        this._macToPath.set(mac, path);
        if (this._proxies.has(path)) return;

        let proxy;
        try {
            proxy = await Gio.DBusProxy.new_for_bus(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START,
                null,
                BLUEZ_BUS, path, BLUEZ_DEVICE,
                null
            );
        } catch (e) {
            return;
        }

        const entry = {proxy, mac, name, sigId: null};

        entry.sigId = proxy.connect('g-properties-changed', (p, changed) => {
            const unpacked = changed.deep_unpack();
            if (!('Connected' in unpacked)) return;

            const isConnected = unpacked['Connected'].unpack?.() ?? unpacked['Connected'];
            if (isConnected) {
                const cfg = this._getColorMap()[mac];
                if (cfg) this._showButton(path, entry, cfg);
            } else {
                this._hideButton(path);
            }
        });

        this._proxies.set(path, entry);

        // Show immediately if already connected and configured
        const connected = dev['Connected']?.unpack?.() ?? dev['Connected'];
        if (connected) {
            const cfg = this._getColorMap()[mac];
            if (cfg) this._showButton(path, entry, cfg);
        }
    }

    _onDeviceAdded(path, ifaces) {
        this._trackDevice(path, ifaces);
    }

    _onDeviceRemoved(path, ifaces) {
        if (!Array.isArray(ifaces) || !ifaces.includes(BLUEZ_DEVICE)) return;
        const entry = this._proxies.get(path);
        if (entry) {
            if (entry.sigId) entry.proxy.disconnect(entry.sigId);
            this._macToPath.delete(entry.mac);
            this._proxies.delete(path);
        }
        this._hideButton(path);
    }

    // -- Button lifecycle -----------------------------------------------------

    _showButton(path, entry, cfg) {
        if (this._buttons.has(path)) return;
        const showBattery = this._settings.get_boolean('show-battery');
        const btn = new ControllerButton(
            entry.proxy,
            cfg.color,
            cfg.name || entry.name,
            this._getIconSize(),
            path,
            showBattery
        );
        btn._mac = entry.mac;
        this._buttons.set(path, btn);
        Main.panel.addToStatusArea(`xbox-ctrl-${path}`, btn);
    }

    _hideButton(path) {
        const btn = this._buttons.get(path);
        if (btn) btn.destroy();
        this._buttons.delete(path);
    }
}
