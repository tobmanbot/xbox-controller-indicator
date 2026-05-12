/**
 * Preferences UI for Xbox Controller Indicator
 * GNOME 46+ (Adw / ESM / GTK 4.10+)
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Promisify D-Bus async methods for use with async/await (GJS 1.78+ / GNOME 46+)
Gio._promisify(Gio.DBusProxy, 'new_for_bus', 'new_for_bus_finish');
Gio._promisify(Gio.DBusProxy.prototype, 'call', 'call_finish');

// --- BlueZ scan --------------------------------------------------------------
const BLUEZ_BUS          = 'org.bluez';
const BLUEZ_PATH         = '/';
const DBUS_OM_IFACE      = 'org.freedesktop.DBus.ObjectManager';
const BLUEZ_DEVICE       = 'org.bluez.Device1';
const GAMEPAD_APPEARANCE = 0x03C4;
const GAMEPAD_KEYWORDS   = ['xbox', 'controller', 'gamepad', 'joystick', 'wireless controller'];

const DEFAULT_COLORS = ['#4fc3f7', '#81c784', '#e57373', '#ffb74d', '#ce93d8', '#fff176'];

async function scanBluetoothGamepads() {
    try {
        const omProxy = await Gio.DBusProxy.new_for_bus(
            Gio.BusType.SYSTEM,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START | Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS,
            null,
            BLUEZ_BUS, BLUEZ_PATH, DBUS_OM_IFACE,
            null
        );
        const result = await omProxy.call(
            'GetManagedObjects', null, Gio.DBusCallFlags.NONE, 5000, null
        );
        const [objects] = result.deep_unpack();
        const gamepads = [];
        for (const [_path, ifaces] of Object.entries(objects)) {
            const dev = ifaces[BLUEZ_DEVICE];
            if (!dev) continue;
            const mac        = (dev['Address']?.unpack?.()    ?? dev['Address']    ?? '').toUpperCase();
            const name       = dev['Name']?.unpack?.()        ?? dev['Name']       ?? mac;
            const paired     = !!(dev['Paired']?.unpack?.()   ?? dev['Paired']);
            const connected  = !!(dev['Connected']?.unpack?.() ?? dev['Connected']);
            const appearance = dev['Appearance']?.unpack?.()  ?? dev['Appearance'] ?? 0;
            if (!paired) continue;
            const nameLower = name.toLowerCase();
            const isGamepad = appearance === GAMEPAD_APPEARANCE ||
                GAMEPAD_KEYWORDS.some(k => nameLower.includes(k));
            if (isGamepad) gamepads.push({mac, name, connected});
        }
        return gamepads;
    } catch (e) {
        console.error('[xbox-controller-indicator prefs] BlueZ scan:', e);
        return [];
    }
}

// --- Configured controller row -----------------------------------------------
const ControllerRow = GObject.registerClass(
class ControllerRow extends Adw.ActionRow {
    _init(mac, color, name, onDelete, onChange) {
        super._init({title: mac});
        this._mac      = mac;
        this._color    = color;
        this._name     = name;
        this._onChange = onChange;

        this._nameEntry = new Gtk.Entry({
            text: name,
            placeholder_text: _('Controller name'),
            valign: Gtk.Align.CENTER,
            width_chars: 16,
        });
        this._nameEntry.connect('changed', () => {
            this._name = this._nameEntry.text;
            this._onChange();
        });

        // Gtk.ColorDialogButton (GTK 4.10+ / GNOME 46+)
        const dialog = new Gtk.ColorDialog({with_alpha: false});
        const rgba = new Gdk.RGBA();
        rgba.parse(color || '#ffffff');
        this._colorBtn = new Gtk.ColorDialogButton({
            dialog,
            rgba,
            valign: Gtk.Align.CENTER,
        });
        this._colorBtn.connect('notify::rgba', () => {
            this._color = this._rgbaToHex(this._colorBtn.rgba);
            this._onChange();
        });

        const delBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
            tooltip_text: _('Delete entry'),
        });
        delBtn.connect('clicked', () => onDelete());

        this.add_suffix(this._nameEntry);
        this.add_suffix(this._colorBtn);
        this.add_suffix(delBtn);
    }

    serialize() {
        return `${this._mac}:${this._color}:${this._name}`;
    }

    get mac() { return this._mac; }

    _rgbaToHex(rgba) {
        const r = Math.round(rgba.red   * 255).toString(16).padStart(2, '0');
        const g = Math.round(rgba.green * 255).toString(16).padStart(2, '0');
        const b = Math.round(rgba.blue  * 255).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`;
    }
});

// --- Discovered device row ---------------------------------------------------
const DiscoveredRow = GObject.registerClass(
class DiscoveredRow extends Adw.ActionRow {
    _init(mac, name, connected, alreadyConfigured, onAdd) {
        super._init({title: name, subtitle: mac});

        const statusLabel = alreadyConfigured
            ? _('✓ configured')
            : connected ? _('🟢 connected') : _('⚪ paired');
        this.add_suffix(new Gtk.Label({
            label: statusLabel,
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        }));

        const addBtn = new Gtk.Button({
            label: alreadyConfigured ? _('Already added') : _('Add'),
            valign: Gtk.Align.CENTER,
            css_classes: alreadyConfigured ? [] : ['suggested-action'],
            sensitive: !alreadyConfigured,
        });
        addBtn.connect('clicked', () => {
            addBtn.sensitive = false;
            addBtn.label = _('✓ Added');
            onAdd(mac, name);
        });
        this.add_suffix(addBtn);
    }
});

// --- Main Prefs --------------------------------------------------------------
export default class XboxControllerPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._rows     = [];

        window.set_default_size(640, 580);

        window.connect('close-request', () => {
            this._settings = null;
            this._rows = [];
            this._discoveredRows = [];
            this._discoveredGroup = null;
            this._configGroup = null;
            this._macEntry = null;
        });

        // ── Page 1: Controllers ───────────────────────────────────────────
        const page = new Adw.PreferencesPage({
            title: _('Controllers'),
            icon_name: 'input-gaming-symbolic',
        });
        window.add(page);

        // ── Discovered group ──────────────────────────────────────────────
        this._discoveredGroup = new Adw.PreferencesGroup({
            title: _('Detected Bluetooth devices'),
            description: _('Paired gamepads – including powered-off ones.\nClick "Add" to configure them.'),
        });
        page.add(this._discoveredGroup);

        const refreshRow = new Adw.ActionRow({title: _('Scan Bluetooth again')});
        const refreshBtn = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Scan BlueZ for gamepad devices'),
        });
        refreshBtn.connect('clicked', () => this._refreshDiscovered());
        refreshRow.add_suffix(refreshBtn);
        this._discoveredGroup.add(refreshRow);

        // ── Configured group ──────────────────────────────────────────────
        this._configGroup = new Adw.PreferencesGroup({
            title: _('Configured controllers'),
            description: _('Color and name for each controller.'),
        });
        page.add(this._configGroup);

        // IMPORTANT: load configured rows FIRST so _populateDiscovered
        // knows which MACs are already configured
        for (const entry of this._settings.get_strv('controller-colors'))
            this._addRowFromString(entry);

        // NOW populate discovered — this._rows is already filled
        this._populateDiscovered();

        // ── Manual add group ──────────────────────────────────────────────
        const manualGroup = new Adw.PreferencesGroup({
            title: _('Add manually'),
            description: _('Enter MAC address directly (format: AA:BB:CC:DD:EE:FF)\nFind it via: bluetoothctl devices'),
        });
        page.add(manualGroup);

        const addRow = new Adw.ActionRow({title: _('MAC address')});
        this._macEntry = new Gtk.Entry({
            placeholder_text: 'AA:BB:CC:DD:EE:FF',
            valign: Gtk.Align.CENTER,
            width_chars: 17,
        });
        const addBtn = new Gtk.Button({
            label: _('Add'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        addBtn.connect('clicked', () => {
            const mac = this._macEntry.text.trim().toUpperCase();
            if (!this._isValidMac(mac) || this._rows.some(r => r.mac === mac)) {
                this._macEntry.add_css_class('error');
                return;
            }
            this._macEntry.remove_css_class('error');
            const color = DEFAULT_COLORS[this._rows.length % DEFAULT_COLORS.length];
            this._addRow(mac, color, mac);
            this._macEntry.text = '';
            this._save();
            this._refreshDiscovered();
        });
        addRow.add_suffix(this._macEntry);
        addRow.add_suffix(addBtn);
        manualGroup.add(addRow);

        // ── Page 2: Appearance ────────────────────────────────────────────
        const appearPage = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'preferences-desktop-appearance-symbolic',
        });
        window.add(appearPage);

        const appearGroup = new Adw.PreferencesGroup({title: _('Icon')});
        appearPage.add(appearGroup);

        const sizeRow = new Adw.SpinRow({
            title: _('Icon size'),
            subtitle: _('Pixels (8–32)'),
            adjustment: new Gtk.Adjustment({
                lower: 8, upper: 32, step_increment: 2,
                value: this._settings.get_int('icon-size'),
            }),
        });
        sizeRow.connect('notify::value', () =>
            this._settings.set_int('icon-size', sizeRow.value));
        appearGroup.add(sizeRow);

        const battRow = new Adw.SwitchRow({
            title: _('Show battery level'),
            subtitle: _('If reported by the controller'),
            active: this._settings.get_boolean('show-battery'),
        });
        battRow.connect('notify::active', () =>
            this._settings.set_boolean('show-battery', battRow.active));
        appearGroup.add(battRow);
    }

    // -- Bluetooth discovery --------------------------------------------------

    async _populateDiscovered() {
        if (this._discoveredRows) {
            for (const r of this._discoveredRows) this._discoveredGroup.remove(r);
        }
        this._discoveredRows = [];

        const configured = new Set(this._rows.map(r => r.mac));
        const gamepads   = await scanBluetoothGamepads();

        if (gamepads.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: _('No paired gamepads found'),
                subtitle: _('Power on or pair a controller, then scan again'),
            });
            this._discoveredGroup.add(emptyRow);
            this._discoveredRows.push(emptyRow);
            return;
        }

        for (const gp of gamepads) {
            const alreadyConfigured = configured.has(gp.mac);
            const row = new DiscoveredRow(
                gp.mac, gp.name, gp.connected, alreadyConfigured,
                (mac, name) => {
                    const color = DEFAULT_COLORS[this._rows.length % DEFAULT_COLORS.length];
                    this._addRow(mac, color, name);
                    this._save();
                    this._refreshDiscovered();
                }
            );
            this._discoveredGroup.add(row);
            this._discoveredRows.push(row);
        }
    }

    _refreshDiscovered() {
        this._populateDiscovered();
    }

    // -- Row management -------------------------------------------------------

    _addRowFromString(entry) {
        const parts = entry.split(':');
        if (parts.length < 7) return;
        const mac   = parts.slice(0, 6).join(':').toUpperCase();
        const color = parts[6];
        const name  = parts.slice(7).join(':') || mac;
        this._addRow(mac, color, name);
    }

    _addRow(mac, color, name) {
        const row = new ControllerRow(
            mac, color, name,
            () => {
                this._rows = this._rows.filter(r => r !== row);
                this._configGroup.remove(row);
                this._save();
                this._refreshDiscovered();
            },
            () => this._save()
        );
        this._rows.push(row);
        this._configGroup.add(row);
        return row;
    }

    _save() {
        this._settings.set_strv(
            'controller-colors',
            this._rows.map(r => r.serialize())
        );
    }

    _isValidMac(mac) {
        return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac);
    }
}
