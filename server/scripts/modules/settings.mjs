import Setting from './utils/setting.mjs';

// Initialize settings immediately so other modules can access them
const settings = { speed: { value: 1.0 } };

// Declare change functions first, before they're referenced in init() to avoid the Temporal Dead Zone (TDZ)
const wideScreenChange = (value) => {
	const container = document.querySelector('#divTwc');
	if (!container) return; // DOM not ready

	if (value) {
		container.classList.add('wide');
	} else {
		container.classList.remove('wide');
	}
	// Trigger resize to recalculate scaling for new width
	window.dispatchEvent(new Event('resize'));
};

const kioskChange = (value) => {
	const body = document.querySelector('body');
	if (!body) return; // DOM not ready

	if (value) {
		body.classList.add('kiosk');
		window.dispatchEvent(new Event('resize'));
	} else {
		body.classList.remove('kiosk');
	}
};

const scanLineChange = (value) => {
	const container = document.getElementById('container');
	const navIcons = document.getElementById('ToggleScanlines');

	if (!container || !navIcons) return; // DOM elements not ready

	if (value) {
		container.classList.add('scanlines');
		navIcons.classList.add('on');
	} else {
		// Remove all scanline classes
		container.classList.remove('scanlines', 'scanlines-auto', 'scanlines-fine', 'scanlines-normal', 'scanlines-thick', 'scanlines-classic', 'scanlines-retro');
		navIcons.classList.remove('on');
	}
};

const scanLineModeChange = (_value) => {
	// Only apply if scanlines are currently enabled
	if (settings.scanLines?.value) {
		// Force a resize to recalculate scanline thickness even if scale hasn't changed
		// Use window object to avoid circular import issues
		if (typeof window.forceResize === 'function') {
			window.forceResize();
		} else {
			// Fallback during startup when navigation.mjs hasn't loaded yet
			window.dispatchEvent(new Event('resize'));
		}
	}
};

const unitChange = () => {
	// reload the data at the top level to refresh units
	// after the initial load
	if (unitChange.firstRunDone) {
		window.location.reload();
	}
	unitChange.firstRunDone = true;
};

const init = () => {
	// create settings see setting.mjs for defaults
	settings.wide = new Setting('wide', {
		name: 'Widescreen',
		defaultValue: false,
		changeAction: wideScreenChange,
		sticky: true,
	});
	settings.kiosk = new Setting('kiosk', {
		name: 'Kiosk',
		defaultValue: false,
		changeAction: kioskChange,
		sticky: false,
	});
	settings.speed = new Setting('speed', {
		name: 'Speed',
		type: 'select',
		defaultValue: 1.0,
		values: [
			[0.5, 'Very Fast'],
			[0.75, 'Fast'],
			[1.0, 'Normal'],
			[1.25, 'Slow'],
			[1.5, 'Very Slow'],
		],
	});
	settings.scanLines = new Setting('scanLines', {
		name: 'Scan Lines',
		defaultValue: false,
		changeAction: scanLineChange,
		sticky: true,
	});
	settings.scanLineMode = new Setting('scanLineMode', {
		name: 'Scan Line Style',
		type: 'select',
		defaultValue: 'auto',
		changeAction: scanLineModeChange,
		sticky: true,
		values: [
			['auto', 'Auto (Adaptive)'],
			['thin', 'Thin (1px)'],
			['medium', 'Medium (2px)'],
			['thick', 'Thick (3px)'],
		],
	});
	settings.units = new Setting('units', {
		name: 'Units',
		type: 'select',
		defaultValue: 'us',
		changeAction: unitChange,
		values: [
			['us', 'US'],
			['si', 'Metric'],
		],
	});
	settings.refreshTime = new Setting('refreshTime', {
		type: 'select',
		defaultValue: 600_000,
		sticky: false,
		values: [
			[30_000, 'TESTING'],
			[300_000, '5 minutes'],
			[600_000, '10 minutes'],
			[900_000, '15 minutes'],
			[1_800_000, '30 minutes'],
		],
		visible: false,
	});
};

init();

// generate html objects
document.addEventListener('DOMContentLoaded', () => {
	const settingHtml = Object.values(settings).map((d) => d.generate());
	const settingsSection = document.querySelector('#settings');
	settingsSection.innerHTML = '';
	settingsSection.append(...settingHtml);
});

export default settings;
