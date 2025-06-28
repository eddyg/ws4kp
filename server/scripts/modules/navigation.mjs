// navigation handles progress, next/previous and initial load messages from the parent frame
import noSleep from './utils/nosleep.mjs';
import STATUS from './status.mjs';
import { wrap } from './utils/calc.mjs';
import { safeJson } from './utils/fetch.mjs';
import { getPoint } from './utils/weather.mjs';
import { debugFlag } from './utils/debug.mjs';
import settings from './settings.mjs';

document.addEventListener('DOMContentLoaded', () => {
	init();
});

const displays = [];
let playing = false;
let progress;
const weatherParameters = {};

const init = async () => {
	// set up resize handler
	window.addEventListener('resize', resize);
	resize();

	generateCheckboxes();
};

const message = (data) => {
	// dispatch event
	if (!data.type) return false;
	if (data.type === 'navButton') return handleNavButton(data.message);
	return console.error(`Unknown event ${data.type}`);
};

const getWeather = async (latLon, haveDataCallback) => {
	// get initial weather data
	const point = await getPoint(latLon.lat, latLon.lon);

	// check if point data was successfully retrieved
	if (!point) {
		return;
	}

	if (typeof haveDataCallback === 'function') haveDataCallback(point);

	try {
		// get stations using centralized safe handling
		const stations = await safeJson(point.properties.observationStations);

		if (!stations) {
			console.warn('Failed to get Observation Stations');
			return;
		}

		// check if stations data is valid
		if (!stations || !stations.features || stations.features.length === 0) {
			console.warn('No Observation Stations found for this location');
			return;
		}

		const StationId = stations.features[0].properties.stationIdentifier;

		let { city } = point.properties.relativeLocation.properties;
		const { state } = point.properties.relativeLocation.properties;

		if (StationId in StationInfo) {
			city = StationInfo[StationId].city;
			[city] = city.split('/');
			city = city.replace(/\s+$/, '');
		}

		// populate the weather parameters
		weatherParameters.latitude = latLon.lat;
		weatherParameters.longitude = latLon.lon;
		weatherParameters.zoneId = point.properties.forecastZone.substr(-6);
		weatherParameters.radarId = point.properties.radarStation.substr(-3);
		weatherParameters.stationId = StationId;
		weatherParameters.weatherOffice = point.properties.cwa;
		weatherParameters.city = city;
		weatherParameters.state = state;
		weatherParameters.timeZone = point.properties.timeZone;
		weatherParameters.forecast = point.properties.forecast;
		weatherParameters.forecastGridData = point.properties.forecastGridData;
		weatherParameters.stations = stations.features;

		// update the main process for display purposes
		populateWeatherParameters(weatherParameters);

		// reset the scroll
		postMessage({ type: 'current-weather-scroll', method: 'reload' });

		// draw the progress canvas and hide others
		hideAllCanvases();
		if (!settings?.kiosk?.value) {
			// In normal mode, hide loading screen and show progress
			// (In kiosk mode, keep the loading screen visible until autoplay starts)
			document.querySelector('#loading').style.display = 'none';
			if (progress) {
				await progress.drawCanvas();
				progress.showCanvas();
			}
		}

		// call for new data on each display
		displays.forEach((display) => display.getData(weatherParameters));
	} catch (error) {
		console.error(`Failed to get weather data: ${error.message}`);
	}
};

// receive a status update from a module {id, value}
const updateStatus = (value) => {
	if (value.id < 0) return;
	if (!progress && !settings?.kiosk?.value) return;

	if (progress) progress.drawCanvas(displays, countLoadedDisplays());

	// first display is hazards and it must load before evaluating the first display
	if (!displays[0] || displays[0].status === STATUS.loading) return;

	// calculate first enabled display
	const firstDisplayIndex = displays.findIndex((display) => display?.enabled && display?.timing?.totalScreens > 0);

	// value.id = 0 is hazards, if they fail to load hot-wire a new value.id to the current display to see if it needs to be loaded
	// typically this plays out as current conditions loads, then hazards fails.
	if (value.id === 0 && (value.status === STATUS.failed || value.status === STATUS.retrying)) {
		value.id = firstDisplayIndex;
		value.status = displays[firstDisplayIndex].status;
	}

	// if hazards data arrives after the firstDisplayIndex loads, then we need to hot wire this to the first display
	if (value.id === 0 && value.status === STATUS.loaded && displays[0] && displays[0].timing && displays[0].timing.totalScreens === 0) {
		value.id = firstDisplayIndex;
		value.status = displays[firstDisplayIndex].status;
	}

	// if this is the first display and we're playing, load it up so it starts playing
	if (isPlaying() && value.id === firstDisplayIndex && value.status === STATUS.loaded) {
		navTo(msg.command.firstFrame);
	}
};

// note: a display that is "still waiting"/"retrying" is considered loaded intentionally
// the weather.gov api has long load times for some products when you are the first
// requester for the product after the cache expires
const countLoadedDisplays = () => displays.reduce((acc, display) => {
	if (display.status !== STATUS.loading) return acc + 1;
	return acc;
}, 0);

const hideAllCanvases = () => {
	displays.forEach((display) => display.hideCanvas());
};

// is playing interface
const isPlaying = () => playing;

// navigation message constants
const msg = {
	response: {	// display to navigation
		previous: Symbol('previous'),		// already at first frame, calling function should switch to previous canvas
		inProgress: Symbol('inProgress'),	// have data to display, calling function should do nothing
		next: Symbol('next'),				// end of frames reached, calling function should switch to next canvas
	},
	command: {	// navigation to display
		firstFrame: Symbol('firstFrame'),
		previousFrame: Symbol('previousFrame'),
		nextFrame: Symbol('nextFrame'),
		lastFrame: Symbol('lastFrame'),	// used when navigating backwards from the begining of the next canvas
	},
};

// receive navigation messages from displays
const displayNavMessage = (myMessage) => {
	if (myMessage.type === msg.response.previous) loadDisplay(-1);
	if (myMessage.type === msg.response.next) loadDisplay(1);
};

// navigate to next or previous
const navTo = (direction) => {
	// test for a current display
	const current = currentDisplay();
	if (progress) progress.hideCanvas();
	if (!current) {
		// special case for no active displays (typically on progress screen)
		// find the first ready display
		let firstDisplay;
		let displayCount = 0;
		do {
			// Check if displayCount is within bounds and the display exists
			if (displayCount < displays.length && displays[displayCount]) {
				const display = displays[displayCount];
				if (display.status === STATUS.loaded && display.timing?.totalScreens > 0) {
					firstDisplay = display;
				}
			}
			displayCount += 1;
		} while (!firstDisplay && displayCount < displays.length);

		if (!firstDisplay) return;

		// In kiosk mode, hide the loading screen when we start showing the first display
		if (settings?.kiosk?.value) {
			document.querySelector('#loading').style.display = 'none';
		}

		firstDisplay.navNext(msg.command.firstFrame);
		firstDisplay.showCanvas();
		return;
	}
	if (direction === msg.command.nextFrame) currentDisplay().navNext();
	if (direction === msg.command.previousFrame) currentDisplay().navPrev();
};

// find the next or previous available display
const loadDisplay = (direction) => {
	const totalDisplays = displays.length;
	const curIdx = currentDisplayIndex();
	let idx;
	let foundSuitableDisplay = false;

	for (let i = 0; i < totalDisplays; i += 1) {
		// convert form simple 0-10 to start at current display index +/-1 and wrap
		idx = wrap(curIdx + (i + 1) * direction, totalDisplays);
		if (displays[idx].status === STATUS.loaded && displays[idx].timing.totalScreens > 0) {
			foundSuitableDisplay = true;
			break;
		}
	}

	// If no other suitable display was found, but current display is still suitable (e.g. user only enabled one display), stay on it
	if (!foundSuitableDisplay && displays[curIdx] && displays[curIdx].status === STATUS.loaded && displays[curIdx].timing.totalScreens > 0) {
		idx = curIdx;
		foundSuitableDisplay = true;
	}

	// if no suitable display was found at all, do NOT proceed to avoid infinite recursion
	if (!foundSuitableDisplay) {
		console.warn('No suitable display found for navigation');
		return;
	}

	const newDisplay = displays[idx];
	// hide all displays
	hideAllCanvases();
	// show the new display and navigate to an appropriate display
	if (direction < 0) newDisplay.showCanvas(msg.command.lastFrame);
	if (direction > 0) newDisplay.showCanvas(msg.command.firstFrame);
};

// get the current display index or value
const currentDisplayIndex = () => displays.findIndex((display) => display.active);
const currentDisplay = () => displays[currentDisplayIndex()];

const setPlaying = (newValue) => {
	playing = newValue;
	const playButton = document.querySelector('#NavigatePlay');
	localStorage.setItem('play', playing);

	if (playing) {
		noSleep(true).catch(() => {
			// Wake lock failed, but continue normally
		});
		playButton.title = 'Pause';
		playButton.src = 'images/nav/ic_pause_white_24dp_2x.png';
	} else {
		noSleep(false).catch(() => {
			// Wake lock disable failed, but continue normally
		});
		playButton.title = 'Play';
		playButton.src = 'images/nav/ic_play_arrow_white_24dp_2x.png';
	}
	// if we're playing and on the progress screen (or in kiosk mode), jump to the next screen
	if (playing && !currentDisplay()) {
		if (progress || settings?.kiosk?.value) {
			navTo(msg.command.firstFrame);
		}
	}
};

// handle all navigation buttons
const handleNavButton = (button) => {
	switch (button) {
		case 'play':
			setPlaying(true);
			break;
		case 'playToggle':
			setPlaying(!playing);
			break;
		case 'stop':
			setPlaying(false);
			break;
		case 'next':
			setPlaying(false);
			navTo(msg.command.nextFrame);
			break;
		case 'previous':
			setPlaying(false);
			navTo(msg.command.previousFrame);
			break;
		case 'menu':
			setPlaying(false);
			if (progress) {
				progress.showCanvas();
			} else if (settings?.kiosk?.value) {
				// In kiosk mode without progress, show the loading screen
				document.querySelector('#loading').style.display = 'flex';
			}
			hideAllCanvases();
			break;
		default:
			console.error(`Unknown navButton ${button}`);
	}
};

// return the specificed display
const getDisplay = (index) => displays[index];

// Track the last applied scale to avoid redundant operations
let lastAppliedScale = null;
let lastAppliedKioskMode = null;

// resize the container on a page resize
const resize = (force = false) => {
	// Ignore resize events caused by pinch-to-zoom on mobile
	if (window.visualViewport && Math.abs(window.visualViewport.scale - 1) > 0.01) {
		return;
	}

	// Check for display optimization opportunities before applying zoom
	const isKioskLike = (settings.kiosk?.value || false) || !!document.fullscreenElement;

	const targetWidth = settings.wide.value ? 640 + 107 + 107 : 640;

	// Use window width instead of bottom container width to avoid zero-dimension issues
	const widthZoomPercent = window.innerWidth / targetWidth;
	const heightZoomPercent = window.innerHeight / 480;

	const scale = Math.min(widthZoomPercent, heightZoomPercent);

	// Prevent zero or negative scale values
	if (scale <= 0) {
		console.warn('Invalid scale calculated, skipping resize');
		return;
	}

	// Skip redundant resize operations if scale and mode haven't changed (unless forced)
	const scaleChanged = Math.abs((lastAppliedScale || 0) - scale) > 0.001;
	const modeChanged = lastAppliedKioskMode !== isKioskLike;

	if (!force && !scaleChanged && !modeChanged) {
		return; // No meaningful change, skip resize operation
	}

	// Update tracking variables
	lastAppliedScale = scale;
	lastAppliedKioskMode = isKioskLike;

	// Use the wrapper approach: scale the entire #divTwc which now contains both content and bottom bar
	const wrapper = document.querySelector('#divTwc');

	if (isKioskLike) {
		// In kiosk mode, always scale to fit the screen exactly and center the content
		const wrapperWidth = settings.wide.value ? 854 : 640;
		const wrapperHeight = 480;
		const scaledWidth = wrapperWidth * scale;
		const scaledHeight = wrapperHeight * scale;
		const offsetX = (window.innerWidth - scaledWidth) / 2;
		const offsetY = (window.innerHeight - scaledHeight) / 2;

		wrapper.style.transform = `scale(${scale}) translate(${offsetX / scale}px, ${offsetY / scale}px)`;
		wrapper.style.transformOrigin = 'top left';
		wrapper.style.width = `${wrapperWidth}px`;
		wrapper.style.height = `${wrapperHeight}px`;
		applyScanlineScaling(scale);
	} else if (scale < 1.0) {
		// In non-kiosk mode, only scale down when content is larger than viewport
		// This ensures mobile devices scale properly while preventing unnecessary desktop scaling
		wrapper.style.transform = `scale(${scale})`;
		wrapper.style.transformOrigin = 'top left';
		// Set explicit dimensions to prevent layout issues on mobile
		const wrapperWidth = settings.wide.value ? 854 : 640;
		// Calculate total height: main content (480px) + bottom bar
		const bottomBar = document.querySelector('#divTwcBottom');
		const bottomBarHeight = bottomBar ? bottomBar.offsetHeight : 40; // fallback to ~40px
		const totalHeight = 480 + bottomBarHeight;
		const scaledHeight = totalHeight * scale; // Height after scaling
		wrapper.style.width = `${wrapperWidth}px`;
		wrapper.style.height = `${scaledHeight}px`; // Use scaled height to eliminate gap
		applyScanlineScaling(scale);
	} else {
		// Content fits naturally, no scaling needed
		wrapper.style.transform = 'none';
		wrapper.style.transformOrigin = '';
		wrapper.style.width = '';
		wrapper.style.height = '';
		applyScanlineScaling(1.0);
	}
};

// reset all statuses to loading on all displays, used to keep the progress bar accurate during refresh
const resetStatuses = () => {
	displays.forEach((display) => { display.status = STATUS.loading; });
};

// Apply scanline scaling to try and prevent banding by avoiding fractional scaling
const applyScanlineScaling = (scale) => {
	const container = document.querySelector('#container');
	if (!container || !container.classList.contains('scanlines')) {
		return;
	}

	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;
	const devicePixelRatio = window.devicePixelRatio || 1;
	const currentMode = settings?.scanLineMode?.value || 'auto';
	let cssThickness;
	let scanlineDebugInfo = null;

	// Manual modes: direct CSS pixel values with no scaling math
	if (currentMode === 'thin') {
		cssThickness = '1px';
		scanlineDebugInfo = {
			css: 1,
			target: '1px CSS',
			error: 0,
			reason: 'Thin: 1px user override',
			isManual: true,
		};
	} else if (currentMode === 'medium') {
		cssThickness = '2px';
		scanlineDebugInfo = {
			css: 2,
			target: '2px CSS',
			error: 0,
			reason: 'Medium: 2px user override',
			isManual: true,
		};
	} else if (currentMode === 'thick') {
		cssThickness = '3px';
		scanlineDebugInfo = {
			css: 3,
			target: '3px CSS',
			error: 0,
			reason: 'Thick: 3px user override',
			isManual: true,
		};
	} else {
		// Auto mode: use adaptive scaling calculations

		// Calculate optimal scanline thickness
		let targetBase = 2; // Start with 2px as a good default base
		let reason;

		const isUnscaled = scale <= 1.1;
		if (isUnscaled) {
			// For base resolution displays, start with thinner scanlines
			targetBase = 1;

			// Increase thickness if necessary for visibility
			const potential1pxRendered = 1 * scale * devicePixelRatio;
			if (potential1pxRendered < 1.0) {
				targetBase = 2; // < 1px might be invisible
				reason = 'Auto: increased from 1px for visibility';
			} else {
				reason = 'Auto: 1px optimal for unscaled display';
			}
		} else if (viewportWidth <= 800 || viewportHeight <= 600) {
			// For low-resolution displays, 1px might be acceptable if the scale factor is good
			const potential1pxRendered = 1 * scale * devicePixelRatio;
			// Only use 1px base if it will render as at least 1.5 physical pixels to avoid banding
			if (potential1pxRendered >= 1.5) {
				targetBase = 1;
				reason = 'Auto: 1px for low-res';
			} else {
				reason = `Auto: ${targetBase}px for low-res (1px too thin)`;
			}
		} else if (devicePixelRatio >= 2 || viewportWidth >= 1920) {
			// For high-DPI displays or high scale factors, use thicker base to avoid banding
			const isHighResolution = viewportWidth >= 1920 && viewportHeight >= 1080;

			// Calculate what the rendered thickness would be with different bases
			const base2Rendered = 2 * scale * devicePixelRatio;
			const base4Rendered = 4 * scale * devicePixelRatio;

			// If 2px base would be too thin (less than 3 physical pixels), use 4px base
			if (base2Rendered < 3.0) {
				targetBase = 4;
			} else if (isHighResolution && devicePixelRatio >= 2) {
				// For very high resolution displays, 3px or 4px looks better
				targetBase = base4Rendered >= 6 ? 4 : 3;
			}

			reason = `Auto: ${targetBase}px optimal for high-DPI/hi-res`;
		} else {
			reason = `Auto: ${targetBase}px default optimal`;
		}

		// Apply safety checks to prevent invisible or banding scanlines
		const calculatedThickness = targetBase / scale;
		const finalRendered = calculatedThickness * scale * devicePixelRatio;

		// If CSS thickness would be less than 1px, increase target base minimally
		if (calculatedThickness < 1.0) {
			targetBase = Math.ceil(scale); // This ensures at least 1px CSS
		}

		// Only increase to thicker scanlines if we're really at risk of invisibility
		// and not in a narrow window scenario where thick scanlines look bad
		const isNarrowWindow = viewportWidth < viewportHeight * 0.8; // Aspect ratio check
		if (finalRendered < 1.5 && !isNarrowWindow && targetBase < 3) {
			targetBase = 3;
		}

		const optimalThickness = targetBase / scale;
		const roundedThickness = Math.round(optimalThickness);
		cssThickness = `${roundedThickness}px`;

		scanlineDebugInfo = {
			css: roundedThickness,
			target: `${targetBase}px`,
			error: Math.abs(roundedThickness * scale - targetBase),
			reason,
			isManual: false,
			optimal: optimalThickness,
			calculatedThickness,
		};
	}

	container.style.setProperty('--scanline-thickness', cssThickness);

	// Output debug information if enabled
	if (debugFlag('scanlines')) {
		const actualRendered = scanlineDebugInfo.css * scale;
		const physicalRendered = actualRendered * devicePixelRatio;

		console.log(`Scanline optimization: ${cssThickness} CSS × ${scale.toFixed(3)} scale × ${devicePixelRatio}x DPI = ${physicalRendered.toFixed(3)}px physical (target: ${scanlineDebugInfo.target}, error: ${scanlineDebugInfo.error.toFixed(6)}) - ${scanlineDebugInfo.reason}`);
		console.log(`  Display: ${viewportWidth}×${viewportHeight}, Scale factors: width=${(window.innerWidth / (settings.wide.value ? 854 : 640)).toFixed(3)}, height=${(window.innerHeight / 480).toFixed(3)}`);
		console.log(`  Thickness analysis: CSS=${cssThickness} ${scanlineDebugInfo.isManual ? '(direct override)' : `(from ${scanlineDebugInfo.optimal.toFixed(3)}px)`}, Rendered=${actualRendered.toFixed(3)}px, Physical=${physicalRendered.toFixed(3)}px`);

		// Additional debug info for auto mode only
		if (!scanlineDebugInfo.isManual) {
			if (scanlineDebugInfo.calculatedThickness < 1.0) {
				console.log(`  Initial CSS thickness was ${scanlineDebugInfo.calculatedThickness.toFixed(3)}px (< 1px), adjusted for visibility`);
			}
			if (Math.abs(scanlineDebugInfo.optimal - scanlineDebugInfo.css) > 0.01) {
				console.log(`  Rounded CSS thickness from ${scanlineDebugInfo.optimal.toFixed(3)}px to ${cssThickness} to prevent fractional rendering`);
			}
		}
	}
};

// Make applyScanlineScaling available for direct calls from Settings
window.applyScanlineScaling = applyScanlineScaling;

// allow displays to register themselves
const registerDisplay = (display) => {
	if (displays[display.navId]) console.warn(`Display nav ID ${display.navId} already in use`);
	displays[display.navId] = display;

	// generate checkboxes
	generateCheckboxes();
};

const generateCheckboxes = () => {
	const availableDisplays = document.querySelector('#enabledDisplays');

	if (!availableDisplays) return;
	// generate checkboxes
	const checkboxes = displays.map((d) => d.generateCheckbox(d.defaultEnabled)).filter((d) => d);

	// write to page
	availableDisplays.innerHTML = '';
	availableDisplays.append(...checkboxes);
};

// special registration method for progress display
const registerProgress = (_progress) => {
	progress = _progress;
};

const populateWeatherParameters = (params) => {
	document.querySelector('#spanCity').innerHTML = `${params.city}, `;
	document.querySelector('#spanState').innerHTML = params.state;
	document.querySelector('#spanStationId').innerHTML = params.stationId;
	document.querySelector('#spanRadarId').innerHTML = params.radarId;
	document.querySelector('#spanZoneId').innerHTML = params.zoneId;
};

const latLonReceived = (data, haveDataCallback) => {
	getWeather(data, haveDataCallback);
};

const timeZone = () => weatherParameters.timeZone;

export {
	updateStatus,
	displayNavMessage,
	resetStatuses,
	isPlaying,
	resize,
	registerDisplay,
	registerProgress,
	currentDisplay,
	getDisplay,
	msg,
	message,
	latLonReceived,
	timeZone,
};
