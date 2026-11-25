// ==UserScript==
// @name         GhostPixel Bot Clean
// @namespace    https://github.com/Fox3225/GeoPixelsBotClean
// @version      1.1.17
// @description  Script GeoPixels pour peindre des images fantômes, synchroniser la progression, recevoir une notification de fin, gérer les priorités de couleurs, acheter les couleurs manquantes et augmenter la capacité d’énergie.
// @author       Fox3225 + Codex
// @match        https://geopixels.net/*
// @match        https://*.geopixels.net/*
// @license      GPL-3.0
// @homepageURL  https://github.com/Daneisra/GeoPixelsBotClean-FR
// @supportURL   https://github.com/Daneisra/GeoPixelsBotClean-FR/issues
// @downloadURL  https://raw.githubusercontent.com/Daneisra/GeoPixelsBotClean-FR/main/ghostpixel-bot-clean.user.js
// @updateURL    https://raw.githubusercontent.com/Daneisra/GeoPixelsBotClean-FR/main/ghostpixel-bot-clean.user.js
// @run-at       document-idle
// @connect      127.0.0.1
// @grant        unsafeWindow
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
	"use strict";

	const win = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
	const VERSION = "1.1.17";
	const ACCOUNT_MONITOR_URL = "http://127.0.0.1:47631/connect";
	const TILE_SIZE = 1000;
	const TILE_BATCH_SIZE = 9;
	const WORK_CHUNK = 32768;
	const BOARD_REFRESH_MS = 30000;
	const DEFAULT_MAINTENANCE_INTERVAL = 30;
	const MIN_MAINTENANCE_INTERVAL = 10;
	const MAX_MAINTENANCE_INTERVAL = 3600;
	const MAINTENANCE_SAMPLE_SIZE = 5;
	const PALETTE_PAGE_SIZE = 20;
	const UNKNOWN_COLOR = -2;
	const PIXEL_UNKNOWN = 0;
	const PIXEL_CORRECT = 1;
	const PIXEL_WRONG = 2;
	const PIXEL_EMPTY = 3;
	const numberFormat = new Intl.NumberFormat("fr-FR");
	const checkTimeFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "medium" });
	const MAX_PIXELS_PER_REQUEST = 5000;
	const REQUEST_PAUSE_MS = 1200;
	const EMPTY_ENERGY_PAUSE_MIN_MS = 15000;
	const ENERGY_POLL_MAX_MS = 60000;
	const PAINT_REQUEST_TIMEOUT_MS = 15000;
	const PURCHASE_RESULT_TIMEOUT_MS = 12000;
	const COLOR_PURCHASE_PAUSE_MS = 1200;
	const MAX_COLOR_PURCHASES_PER_RUN = 5;
	const ENERGY_CAPACITY_PURCHASE_CHUNK = 50;
	const SETTINGS_KEY = "ghostpixel_clean_settings";
	const DRAWING_STRATEGIES = {
		"top-down": { label: "Haut vers bas", description: "Commence par la rangée du haut. Chaque rangée avance de gauche à droite." },
		"bottom-up": { label: "Bas vers haut", description: "Commence par la rangée du bas. Chaque rangée avance de gauche à droite." },
		"left-right": { label: "Gauche vers droite", description: "Commence par la colonne de gauche. Chaque colonne descend du haut vers le bas." },
		"right-left": { label: "Droite vers gauche", description: "Commence par la colonne de droite. Chaque colonne descend du haut vers le bas." },
		"center-out": { label: "Centre vers extérieur", description: "Commence près du centre du rectangle qui encadre les pixels sélectionnés." },
		"outside-in": { label: "Extérieur vers centre", description: "Commence par les pixels les plus éloignés du centre de la sélection." },
		"contours": { label: "Contours en priorité", description: "Traite d’abord les bordures de la sélection et les limites entre deux couleurs." },
		"color": { label: "Par couleur", description: "Regroupe les pixels d’une même couleur, en commençant par les couleurs les moins présentes." },
		"smart": { label: "Priorité intelligente", description: "Traite d’abord les petites régions de même couleur, puis départage selon la rareté." },
		"random": { label: "Aléatoire", description: "Mélange l’ordre des pixels. Une sélection identique conserve le même ordre entre les sessions." },
	};
	const PREVIEW_COLORS = [0x64748B, 0x0F766E, 0x7C3AED];
	const AUTO_UPGRADES = {
		FasterRecharge: { label: "Vitesse de recharge", input: "FasterRechargeInput", tariff: /^(\d+) Pixels\s*\/\s*-1\s*s\s*\(cap at (\d+)\s*s\)$/i },
		EnergyCapacity: { label: "Capacité énergétique", input: "EnergyCapacityInput", tariff: /^(\d+) Pixels\s*\/\s*\+5 max$/i },
		Energy: { label: "Recharge d’énergie", input: "EnergyInput", tariff: /^(\d+) Pixels\s*\/\s*\+20 energy$/i },
		ExtraColor: { label: "Couleurs manquantes", input: "ExtraColorInput", tariff: /^(\d+) Pixels\s*\/\s*Any hex color allowed$/i },
	};
	const AUTO_UPGRADE_ORDER = Object.keys(AUTO_UPGRADES);
	// Le profil GeoPixels inclut la transparence dans son compteur de 35 couleurs.
	const FREE_COLOR_PALETTE_LIMIT = 35;
	const DEFAULT_ENERGY_SETTINGS = {
		energyMode: "salvos",
		startEnergyUnit: "percent",
		startEnergyThreshold: 100,
		resumeEnergyUnit: "percent",
		resumeEnergyThreshold: 100,
		energyReserve: 0,
		maxBatchSize: 0,
	};
	const SALVO_LABELS = {
		start: "Attente du démarrage",
		active: "Salve en cours",
		resume: "Attente de la reprise",
	};
	const STATUS_LABELS = {
		idle: "Prêt",
		syncing: "Synchronisation",
		running: "Peinture",
		watching: "Surveillance",
		waiting: "En attente",
		buying: "Achat",
		done: "Terminé",
		stopped: "Arrêté",
		error: "Erreur",
	};

	const state = {
		running: false,
		syncing: false,
		stopRequested: false,
		placedThisRun: 0,
		paintedGroups: 0,
		runStartedAt: 0,
		runNumber: 0,
		remaining: 0,
		energy: null,
		salvoPhase: "start",
		nextBatchSize: 0,
		rechargePending: false,
		monitoring: false,
		maintenanceStatus: "Inactive",
		maintenanceCheck: null,
		status: "idle",
		message: "Prêt",
	};

	let settings = loadSettings();
	let stopWake = null;
	let targetCache = null;
	let purchaseTargetCache = null;
	let modelCache = null;
	let imageAnalysis = null;
	let accountColors = null;
	let accountReadSequence = 0;
	let nativePalette = null;
	let paletteReading = { sequence: 0, accountId: null, status: "loading", source: null, httpStatus: null, format: null, native: null, reason: null };
	let baseColors = null;
	let baseColorsRequest = null;
	let targetPreview = null;
	let drawingPreviewKey = null;
	let targetRevision = 0;
	let purchaseObserverInstalled = false;
	let originalFetch = null;
	let authCache = null;
	let completionNotificationSent = false;
	let hadPendingTargets = false;
	let purchaseInFlight = false;
	const autoPurchases = { balance: null, spent: 0, next: "", message: "", retryAt: 0 };
	const purchaseEvents = [];
	const paletteView = { image: null, histogram: null, page: 0, request: 0, timer: null, accountId: null };
	const ui = {};

	function log(level, ...args) {
		console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
			"%c[GhostPixel Clean]",
			"color:#38bdf8;font-weight:700",
			...args
		);
	}

	function storageGet(key) {
		try {
			const value = win.localStorage && win.localStorage.getItem(key);
			if (value !== null && value !== undefined) return value;
		} catch {}
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}

	function storageSet(key, value) {
		try {
			if (win.localStorage) {
				win.localStorage.setItem(key, value);
				return;
			}
		} catch {}
		try {
			localStorage.setItem(key, value);
		} catch {}
	}

	function installLargeGhostStorageBridge() {
		try {
			const script = document.createElement("script");
			script.textContent = `
				(() => {
					if (window.__gpcLargeGhostStorageInstalled) return;
					window.__gpcLargeGhostStorageInstalled = true;
					const KEY = "ghostImageData";
					const DB_NAME = "GhostPixelLargeAssets";
					const STORE_NAME = "templates";
					const originalGetItem = Storage.prototype.getItem;
					const originalSetItem = Storage.prototype.setItem;
					const originalRemoveItem = Storage.prototype.removeItem;
					let templateChanged = false;
					const openDatabase = () => new Promise((resolve, reject) => {
						const request = indexedDB.open(DB_NAME, 1);
						request.onupgradeneeded = () => {
							if (!request.result.objectStoreNames.contains(STORE_NAME)) {
								request.result.createObjectStore(STORE_NAME);
							}
						};
						request.onsuccess = () => resolve(request.result);
						request.onerror = () => reject(request.error);
					});
					const writeLargeTemplate = async (value) => {
						const database = await openDatabase();
						await new Promise((resolve, reject) => {
							const transaction = database.transaction(STORE_NAME, "readwrite");
							transaction.objectStore(STORE_NAME).put(value, KEY);
							transaction.oncomplete = resolve;
							transaction.onerror = () => reject(transaction.error);
						});
						database.close();
					};
					const readLargeTemplate = async () => {
						const database = await openDatabase();
						const value = await new Promise((resolve, reject) => {
							const request = database.transaction(STORE_NAME, "readonly")
								.objectStore(STORE_NAME).get(KEY);
							request.onsuccess = () => resolve(request.result || null);
							request.onerror = () => reject(request.error);
						});
						database.close();
						return value;
					};
					const deleteLargeTemplate = async () => {
						const database = await openDatabase();
						await new Promise((resolve, reject) => {
							const transaction = database.transaction(STORE_NAME, "readwrite");
							transaction.objectStore(STORE_NAME).delete(KEY);
							transaction.oncomplete = resolve;
							transaction.onerror = () => reject(transaction.error);
						});
						database.close();
					};

					Storage.prototype.getItem = function (key) {
						if (this === window.localStorage && String(key) === KEY && window.__gpcLargeGhostValue) {
							return window.__gpcLargeGhostValue;
						}
						return originalGetItem.call(this, key);
					};
					Storage.prototype.setItem = function (key, value) {
						if (this !== window.localStorage || String(key) !== KEY) {
							return originalSetItem.call(this, key, value);
						}
						templateChanged = true;
						try {
							originalSetItem.call(this, key, value);
							window.__gpcLargeGhostValue = null;
							deleteLargeTemplate().catch(() => {});
						} catch (error) {
							if (!error || (error.name !== "QuotaExceededError" && error.code !== 22)) throw error;
							originalRemoveItem.call(this, key);
							window.__gpcLargeGhostValue = String(value);
							writeLargeTemplate(String(value)).catch((storageError) => {
								console.error("[GhostPixel] Impossible d’enregistrer le grand modèle", storageError);
							});
						}
					};
					Storage.prototype.removeItem = function (key) {
						if (this === window.localStorage && String(key) === KEY) {
							templateChanged = true;
							window.__gpcLargeGhostValue = null;
							deleteLargeTemplate().catch(() => {});
						}
						return originalRemoveItem.call(this, key);
					};

					const restoreLargeTemplate = async () => {
						if (originalGetItem.call(window.localStorage, KEY)) return;
						const value = await readLargeTemplate();
						if (!value || templateChanged || originalGetItem.call(window.localStorage, KEY)) return;
						window.__gpcLargeGhostValue = value;
						let attempts = 0;
						const restoreWhenReady = () => {
							if (templateChanged || window.__gpcLargeGhostValue !== value) return;
							if (typeof window.initializeGhostFromStorage === "function") {
								window.initializeGhostFromStorage();
								return;
							}
							if (++attempts < 40) setTimeout(restoreWhenReady, 250);
						};
						restoreWhenReady();
					};
					restoreLargeTemplate().catch(() => {});
				})();
			`;
			(document.documentElement || document.head).appendChild(script);
			script.remove();
		} catch (error) {
			log("warn", "Impossible d’activer le stockage des grands modèles.", error);
		}
	}

	installLargeGhostStorageBridge();

	function installPageBridge() {
		try {
			if (
				typeof win.__gpcReadGlobal === "function" &&
				typeof win.__gpcPlacePixels === "function" &&
				typeof win.__gpcMakePurchase === "function" &&
				typeof win.__gpcGetUserData === "function" &&
				typeof win.__gpcGetFetchEvents === "function" &&
				typeof win.__gpcSelectArea === "function" &&
				typeof win.__gpcRenderAreas === "function"
			) {
				return true;
			}
			const script = document.createElement("script");
			script.textContent = `
				(() => {
					const readPageGlobal = (name) => {
						try { return eval(name); }
						catch (error) { return undefined; }
					};
					const authSnapshot = () => {
						const data = {};
						try { data.tokenUser = typeof tokenUser !== "undefined" ? tokenUser : ""; } catch {}
						try { data.subject = typeof subject !== "undefined" ? subject : ""; } catch {}
						try { data.userID = typeof userID !== "undefined" ? userID : null; } catch {}
						try { data.userData = typeof userData !== "undefined" ? userData : null; } catch {}
						return data;
					};
					const authPayload = () => {
						const data = authSnapshot();
						const rawUserId = data.userID || (data.userData && data.userData.id);
						const parsedUserId = Number(rawUserId);
						const loginSubject = data.subject || (data.userData && data.userData.subject) || "";
						if (!data.tokenUser || !Number.isFinite(parsedUserId) || !loginSubject) {
							return {
								error: "Session GeoPixels introuvable. Actualisez la page ou reconnectez-vous.",
								debug: {
									hasToken: !!data.tokenUser,
									hasSubject: !!loginSubject,
									userID: rawUserId || null
								}
							};
						}
						return {
							Token: String(data.tokenUser),
							Subject: String(loginSubject),
							UserId: Math.trunc(parsedUserId)
						};
					};
					const readResponse = async (response) => ({
						ok: response.ok,
						status: response.status,
						retryAfter: response.headers.get("Retry-After"),
						text: await response.text().catch(() => "")
					});
					const requestUrlOf = (input) => {
						try {
							const url = new URL(input && input.url ? input.url : input, location.href);
							return url.origin === location.origin ? url.pathname : "";
						} catch {
							return "";
						}
					};
					const shouldRecordFetch = (requestUrl) =>
						["/MakePurchase", "/GetUserData", "/PlacePixels"].includes(requestUrl);
					if (!window.__gpcFetchEvents) {
						Object.defineProperty(window, "__gpcFetchEvents", {
							configurable: true,
							value: []
						});
					}
					const recordFetchEvent = (requestUrl, response) => {
						try {
							window.__gpcFetchEvents.push({
								url: requestUrl,
								ok: response.ok,
								status: response.status,
								at: new Date().toISOString()
							});
							if (window.__gpcFetchEvents.length > 80) {
								window.__gpcFetchEvents.splice(0, window.__gpcFetchEvents.length - 80);
							}
						} catch {}
					};
					if (!window.__gpcFetchRecorderInstalled && typeof window.fetch === "function") {
						const originalFetch = window.fetch.bind(window);
						Object.defineProperty(window, "__gpcFetchRecorderInstalled", {
							configurable: true,
							value: true
						});
						window.fetch = async (input, init) => {
							const requestUrl = requestUrlOf(input);
							const response = await originalFetch(input, init);
							if (shouldRecordFetch(requestUrl)) {
								recordFetchEvent(requestUrl, response);
							}
							if (requestUrl === "/MakePurchase" && response.status === 200) {
								window.dispatchEvent(new Event("gpc-account-purchase"));
							}
							return response;
						};
					}
					const currentEnergyFromData = (data) => {
						if (!data) return null;
						const energy = Number(data.energy);
						const max = Number(data.maxEnergy);
						const rate = Number(data.energyRate);
						const checked = Number(data.checkedTick);
						if (![energy, max, rate, checked].every(Number.isFinite) || rate <= 0) return null;
						if (energy > max) return Math.max(0, Math.floor(energy));
						const now = Math.floor(Date.now() / 1000);
						const regenerated = Math.max(0, Math.floor((now - checked) / rate));
						return Math.max(0, Math.floor(Math.min(energy + regenerated, max)));
					};
					const applyUserData = (data) => {
						if (!data) return;
						try { userData = data; } catch {}
						try { maxEnergy = Number(data.maxEnergy) || maxEnergy; } catch {}
						try { energyRate = Number(data.energyRate) || energyRate; } catch {}
						const energy = currentEnergyFromData(data);
						if (energy !== null) {
							try { currentEnergy = energy; } catch {}
						}
					};
					Object.defineProperty(window, "__gpcReadGlobal", {
						configurable: true,
						value: readPageGlobal
					});
					Object.defineProperty(window, "__gpcAuthSnapshot", {
						configurable: true,
						value: authSnapshot
					});
					Object.defineProperty(window, "__gpcGetFetchEvents", {
						configurable: true,
						value: () => window.__gpcFetchEvents.slice()
					});
					Object.defineProperty(window, "__gpcPlacePixels", {
						configurable: true,
						value: async (pixels) => {
							const auth = authPayload();
							if (auth.error) {
								return { ok: false, status: 0, needsSession: true, text: auth.error, debug: auth.debug };
							}
							const cleanPixels = (Array.isArray(pixels) ? pixels : [])
								.map((pixel) => ({
									GridX: Number(pixel.GridX),
									GridY: Number(pixel.GridY),
									Color: Number(pixel.Color),
									UserId: auth.UserId
								}))
								.filter((pixel) =>
									Number.isFinite(pixel.GridX) &&
									Number.isFinite(pixel.GridY) &&
									Number.isFinite(pixel.Color) &&
									Number.isFinite(pixel.UserId)
								);
							if (!cleanPixels.length) {
								return { ok: false, status: 0, text: "Aucun pixel valide à envoyer." };
							}
							try {
								return await readResponse(await fetch("/PlacePixels", {
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({ ...auth, Pixels: cleanPixels }),
									signal: AbortSignal.timeout(${PAINT_REQUEST_TIMEOUT_MS})
								}));
							} catch (error) {
								return { ok: false, status: 0, requestUncertain: true, text: String(error) };
							}
						}
					});
					Object.defineProperty(window, "__gpcMakePurchase", {
						configurable: true,
						value: async (type, amount, expectedUserId) => {
							const auth = authPayload();
							if (auth.error) {
								return { ok: false, status: 0, needsSession: true, text: auth.error, debug: auth.debug, type, amount };
							}
							if (expectedUserId != null && auth.UserId !== expectedUserId) {
								return { ok: false, status: 401, text: "Le compte GeoPixels a changé." };
							}
							try {
								return await readResponse(await fetch("/MakePurchase", {
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({ ...auth, type, amount }),
									signal: AbortSignal.timeout(${PURCHASE_RESULT_TIMEOUT_MS})
								}));
							} catch (error) {
								return {
									ok: false,
									status: 0,
									text: error && error.message ? error.message : String(error),
									requestUncertain: true,
									type,
									amount
								};
							}
						}
					});
					Object.defineProperty(window, "__gpcGetUserData", {
						configurable: true,
						value: async () => {
							const auth = authPayload();
							if (auth.error) {
								return { ok: false, status: 0, needsSession: true, text: auth.error, debug: auth.debug, data: null };
							}
							try {
								const response = await fetch("/GetUserData", {
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({ userId: auth.UserId, token: auth.Token }),
									signal: AbortSignal.timeout(${PAINT_REQUEST_TIMEOUT_MS})
								});
								const text = await response.text().catch(() => "");
								let data = null;
								try { data = JSON.parse(text); } catch {}
								if (response.ok && data) applyUserData(data);
								return {
									ok: response.ok,
									status: response.status,
									retryAfter: response.headers.get("Retry-After"),
									serverDate: response.headers.get("Date"),
									text,
									data
								};
							} catch (error) {
								return {
									ok: false,
									status: 0,
									text: error && error.message ? error.message : String(error),
									data: null
								};
							}
						}
					});
					Object.defineProperty(window, "__gpcSelectArea", {
						configurable: true,
						value: () => new Promise((resolve, reject) => {
							const pageMap = readPageGlobal("map");
							const pixelSize = Number(readPageGlobal("gridSize"));
							if (!pageMap || !window.turf || !Number.isFinite(pixelSize)) {
								reject(new Error("La carte est en cours de chargement."));
								return;
							}
							const container = pageMap.getCanvasContainer();
							const canvas = pageMap.getCanvas();
							const previousCursor = canvas.style.cursor;
							const points = [];
							const cleanup = () => {
								document.removeEventListener("click", onClick, true);
								document.removeEventListener("keydown", onKey, true);
								canvas.style.cursor = previousCursor;
							};
							const onKey = (event) => {
								if (event.key !== "Escape") return;
								cleanup();
								reject(new Error("Sélection annulée."));
							};
							const onClick = (event) => {
								if (!container.contains(event.target)) return;
								event.preventDefault();
								event.stopPropagation();
								event.stopImmediatePropagation();
								const rect = container.getBoundingClientRect();
								const lngLat = pageMap.unproject([event.clientX - rect.left, event.clientY - rect.top]);
								const mercator = window.turf.toMercator([lngLat.lng, lngLat.lat]);
								points.push({
									x: Math.round(mercator[0] / pixelSize),
									y: Math.round(mercator[1] / pixelSize)
								});
								if (points.length < 2) return;
								cleanup();
								resolve(points);
							};
							canvas.style.cursor = "crosshair";
							document.addEventListener("click", onClick, true);
							document.addEventListener("keydown", onKey, true);
						})
					});
					Object.defineProperty(window, "__gpcRenderAreas", {
						configurable: true,
						value: (areas, attempt = 0) => {
							const pageMap = readPageGlobal("map");
							const pixelSize = Number(readPageGlobal("gridSize"));
							if (!pageMap || !window.turf || !Number.isFinite(pixelSize)) {
								if (attempt < 20) setTimeout(() => window.__gpcRenderAreas(areas, attempt + 1), 500);
								return false;
							}
							const sourceId = "gpc-area-filters";
							const featureCollection = {
								type: "FeatureCollection",
								features: (Array.isArray(areas) ? areas : []).map((area) => {
									const minX = Math.min(Number(area.x1), Number(area.x2)) - 0.5;
									const maxX = Math.max(Number(area.x1), Number(area.x2)) + 0.5;
									const minY = Math.min(Number(area.y1), Number(area.y2)) - 0.5;
									const maxY = Math.max(Number(area.y1), Number(area.y2)) + 0.5;
									const toLngLat = (x, y) => window.turf.toWgs84([x * pixelSize, y * pixelSize]);
									return {
										type: "Feature",
										properties: { mode: area.mode === "exclude" ? "exclude" : "include" },
										geometry: {
											type: "Polygon",
											coordinates: [[
												toLngLat(minX, minY), toLngLat(maxX, minY),
												toLngLat(maxX, maxY), toLngLat(minX, maxY),
												toLngLat(minX, minY)
											]]
										}
									};
								})
							};
							const draw = () => {
								const existing = pageMap.getSource(sourceId);
								if (existing) {
									existing.setData(featureCollection);
									return true;
								}
								pageMap.addSource(sourceId, { type: "geojson", data: featureCollection });
								pageMap.addLayer({
									id: sourceId + "-fill", type: "fill", source: sourceId,
									paint: {
										"fill-color": ["match", ["get", "mode"], "exclude", "#ef4444", "#22c55e"],
										"fill-opacity": 0.13
									}
								});
								pageMap.addLayer({
									id: sourceId + "-line", type: "line", source: sourceId,
									paint: {
										"line-color": ["match", ["get", "mode"], "exclude", "#ef4444", "#22c55e"],
										"line-width": 2
									}
								});
								return true;
							};
							if (pageMap.isStyleLoaded()) return draw();
							pageMap.once("styledata", draw);
							return true;
						}
					});
				})();
			`;
			(document.head || document.documentElement).appendChild(script);
			script.remove();
		} catch {}
		return typeof win.__gpcReadGlobal === "function";
	}

	function loadSettings() {
		const fallback = {
			...DEFAULT_ENERGY_SETTINGS,
			workMode: "construction",
			maintenanceInterval: DEFAULT_MAINTENANCE_INTERVAL,
			autoMaintenance: false,
			automaticPurchases: normalizeAutomaticPurchases(),
			includeFreeColors: true,
			includeTransparent: false,
			ignoredColors: [],
			priorityColors: [],
			onlyPriorityColors: false,
			smartPriority: true,
			drawingStrategy: "smart",
			drawingSeed: 0,
			prioritizeIncorrectColors: false,
			areas: [],
			panelLeft: null,
			panelTop: null,
			minimized: false,
		};
		try {
			const stored = JSON.parse(storageGet(SETTINGS_KEY) || "{}");
			const loaded = { ...fallback, ...stored };
			Object.assign(loaded, normalizeEnergySettings(loaded));
			loaded.workMode = loaded.workMode === "maintenance" ? "maintenance" : "construction";
			loaded.maintenanceInterval = normalizeMaintenanceInterval(loaded.maintenanceInterval);
			loaded.autoMaintenance = loaded.autoMaintenance === true;
			loaded.automaticPurchases = normalizeAutomaticPurchases(loaded.automaticPurchases);
			loaded.ignoredColors = Array.isArray(loaded.ignoredColors)
				? loaded.ignoredColors.map(toColorId).filter((id) => id !== null)
				: [];
			loaded.priorityColors = Array.isArray(loaded.priorityColors)
				? loaded.priorityColors.map(toColorId).filter((id) => id !== null)
				: [];
			// Jusqu’à la v1.1.14, une liste de priorités limitait aussi la sélection.
			loaded.onlyPriorityColors = stored?.onlyPriorityColors === undefined
				? loaded.priorityColors.length > 0 : stored.onlyPriorityColors === true;
			loaded.drawingStrategy = Object.hasOwn(DRAWING_STRATEGIES, stored?.drawingStrategy)
				? stored.drawingStrategy : stored?.smartPriority === false ? "color" : "smart";
			loaded.drawingSeed = Number.isInteger(loaded.drawingSeed) ? loaded.drawingSeed >>> 0 : 0;
			loaded.smartPriority = loaded.drawingStrategy === "smart";
			loaded.prioritizeIncorrectColors = loaded.prioritizeIncorrectColors === true;
			loaded.areas = Array.isArray(loaded.areas)
				? loaded.areas.map(normalizeArea).filter(Boolean)
				: [];
			return loaded;
		} catch {
			return fallback;
		}
	}

	function normalizeMaintenanceInterval(value) {
		return Math.max(MIN_MAINTENANCE_INTERVAL, clampPositiveInt(
			value, DEFAULT_MAINTENANCE_INTERVAL, MAX_MAINTENANCE_INTERVAL
		));
	}

	function normalizeEnergySettings(values) {
		const startEnergyUnit = values.startEnergyUnit === "absolute" ? "absolute" : "percent";
		const resumeEnergyUnit = values.resumeEnergyUnit === "absolute" ? "absolute" : "percent";
		const threshold = (value, unit) =>
			clampPositiveInt(value, 100, unit === "percent" ? 100 : Number.MAX_SAFE_INTEGER);
		const nonnegative = (value) => Number.isSafeInteger(Number(value)) ? Math.max(0, Number(value)) : 0;
		return {
			energyMode: values.energyMode === "continuous" ? "continuous" : "salvos",
			startEnergyUnit,
			startEnergyThreshold: threshold(values.startEnergyThreshold, startEnergyUnit),
			resumeEnergyUnit,
			resumeEnergyThreshold: threshold(values.resumeEnergyThreshold, resumeEnergyUnit),
			energyReserve: nonnegative(values.energyReserve),
			maxBatchSize: Math.min(MAX_PIXELS_PER_REQUEST, nonnegative(values.maxBatchSize)),
		};
	}

	function saveSettings() {
		storageSet(SETTINGS_KEY, JSON.stringify(settings));
	}

	function normalizeAutomaticPurchases(values) {
		const config = values || {};
		const order = [...new Set(Array.isArray(config.order) ? config.order : [])]
			.filter((type) => Object.hasOwn(AUTO_UPGRADES, type));
		const nonnegative = (value) => Number.isSafeInteger(Number(value)) ? Math.max(0, Number(value)) : 0;
		return {
			policy: ["limited", "unlimited"].includes(config.policy) ? config.policy : "off",
			reserve: nonnegative(config.reserve),
			limit: nonnegative(config.limit),
			order: [...new Set([...order, ...AUTO_UPGRADE_ORDER])],
			enabled: AUTO_UPGRADE_ORDER.filter((type) => Array.isArray(config.enabled) && config.enabled.includes(type)),
			accountId: Number.isSafeInteger(config.accountId) && config.accountId > 0 ? config.accountId : null,
		};
	}

	function readGlobal(name) {
		installPageBridge();
		try {
			if (typeof win.__gpcReadGlobal === "function") {
				const bridged = win.__gpcReadGlobal(name);
				if (typeof bridged !== "undefined") return bridged;
			}
		} catch {}
		try {
			if (typeof win[name] !== "undefined") return win[name];
		} catch {}
		try {
			if (typeof win.eval === "function") {
				return win.eval("typeof " + name + " !== 'undefined' ? " + name + " : undefined");
			}
		} catch {}
		return undefined;
	}

	function normalizeUserId(value) {
		if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
		if (typeof value !== "string") return null;

		const trimmed = value.trim();
		if (/^\d+$/.test(trimmed)) return Number(trimmed);

		const hashMatch = trimmed.match(/#(\d+)$/);
		if (hashMatch) return Number(hashMatch[1]);

		const numericMatch = trimmed.match(/\d+/);
		return numericMatch ? Number(numericMatch[0]) : null;
	}

	function toColorId(value) {
		if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
		if (value && typeof value === "object") {
			const r = value.r ?? value.R;
			const g = value.g ?? value.G;
			const b = value.b ?? value.B;
			const a = value.a ?? value.A ?? 255;
			if ([r, g, b, a].every((n) => Number.isFinite(Number(n)))) {
				return rgbaToColorId(Number(r), Number(g), Number(b), Number(a));
			}
			return null;
		}
		if (typeof value !== "string") return null;

		let text = value.trim();
		if (!text) return null;
		if (/^-?\d+$/.test(text)) return Number(text);
		if (text.toLowerCase() === "transparent") return -1;

		if (text.startsWith("#")) text = text.slice(1);
		if (/^[0-9a-fA-F]{3,4}$/.test(text)) {
			text = text.split("").map((c) => c + c).join("");
		}
		if (/^[0-9a-fA-F]{8}$/.test(text)) {
			const alpha = parseInt(text.slice(6, 8), 16);
			if (alpha === 0) return -1;
			text = text.slice(0, 6);
		}
		if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
		return parseInt(text, 16);
	}

	function rgbaToColorId(r, g, b, a) {
		if (a === 0) return -1;
		return ((r & 255) << 16) + ((g & 255) << 8) + (b & 255);
	}

	function colorHex(id) {
		if (id === -1) return "#00000000";
		return "#" + (id & 0xffffff).toString(16).padStart(6, "0").toUpperCase();
	}

	function tileKey(x, y) {
		return tileOrigin(x) + "_" + tileOrigin(y);
	}

	function tileOrigin(value) {
		return Math.floor(value / TILE_SIZE) * TILE_SIZE;
	}

	function parseTileKey(key) {
		const cleanKey = String(key || "").replace(/^tile[_-]?/i, "").replace(",", "_");
		const [x, y] = (cleanKey.match(/-?\d+/g) || []).map(Number);
		return { x, y };
	}

	function chunk(array, size) {
		const chunks = [];
		for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
		return chunks;
	}

	function clampPositiveInt(value, fallback = 1, max = 999999) {
		const number = Math.floor(Number(value));
		if (!Number.isFinite(number) || number < 1) return fallback;
		return Math.min(number, max);
	}

	function delay(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function withTimeout(promise, timeoutMs, message) {
		let timeoutId;
		return Promise.race([
			Promise.resolve(promise),
			new Promise((resolve, reject) => {
				timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]).finally(() => clearTimeout(timeoutId));
	}

	function parseColorList(text) {
		return String(text || "")
			.split(",")
			.map((part) => toColorId(part.trim()))
			.filter((id) => id !== null);
	}

	function getOwnedColorIds() {
		const { userId: accountId, token } = getAuthPayload();
		if (!token || !(accountId > 0)) return null;
		if (accountColors?.accountId === accountId) return accountColors.colors;
		const data = readGlobal("userData");
		return accountId === normalizeUserId(data?.id) ? accountPalette(data) : null;
	}

	function acceptAccountPalette(accountId, colors) {
		const previous = accountColors?.colors;
		if (accountColors?.accountId === accountId && previous.size === colors.size &&
			[...colors].every((color) => previous.has(color))) return;
		accountColors = { accountId, colors };
		if (!state.monitoring) invalidateTargets();
		if (ui.paletteSection?.open) {
			renderPalette();
			queueTargetPreview();
		}
	}

	function clearPreviousPalette(accountId) {
		if (!accountColors || accountColors.accountId === accountId) return;
		accountColors = null;
		if (!state.monitoring && settings.workMode === "construction") {
			invalidateTargets();
			updateProgress();
		}
	}

	function observeNativePalette(accountId, verifiedColors) {
		const raw = readGlobal("Colors");
		const liveId = normalizeUserId(readGlobal("userID"));
		const profileId = normalizeUserId(readGlobal("userData")?.id);
		const session = liveId === accountId && accountId > 0 && !!readGlobal("tokenUser") &&
			(profileId === null || profileId === accountId);
		const previous = nativePalette;
		const sameList = previous && previous.raw === raw;
		const colors = sameList ? previous.colors : Array.isArray(raw) ? normalizeAccountColors(raw) : null;
		// Colors commence par la palette publique et peut subsister après déconnexion.
		const matchesAccount = colors && verifiedColors && colors.size === verifiedColors.size &&
			[...colors].every((color) => verifiedColors.has(color));
		const tiedToAccount = session && colors && (matchesAccount ||
			(!verifiedColors && previous?.accountId === accountId && (sameList ? previous.tiedToAccount : colors.size > 0)));
		nativePalette = { raw, colors, accountId: session ? accountId : null, tiedToAccount };
		return {
			colors: tiedToAccount ? colors : null,
			state: !Array.isArray(raw) ? "Inaccessible" : !colors ? "Format non reconnu"
				: tiedToAccount ? "Rattachée au compte" : "Visible, rattachement non vérifié",
		};
	}

	function setPaletteReading(sequence, fields) {
		if (sequence < paletteReading.sequence) return;
		const changed = Object.entries(fields).some(([key, value]) => paletteReading[key] !== value);
		paletteReading = { sequence, ...fields };
		if (changed) renderPalette();
	}

	function reportAccountPalette(accountId, sequence, data, status, previousProfile, reason) {
		if (sequence < paletteReading.sequence || accountId !== getAuthPayload().userId) return;
		const value = data?.colors;
		const api = accountPalette(data);
		const profile = !api && accountId > 0 && normalizeUserId(previousProfile?.id) === accountId
			&& accountPalette(previousProfile);
		const native = observeNativePalette(accountId, api || profile);
		const colors = api || profile || native.colors;
		const format = Array.isArray(value) ? "tableau" : typeof value === "string" ? "liste texte"
			: value == null ? "champ absent" : "format non reconnu";
		const source = api ? "/GetUserData" : profile ? "Profil de la page" : native.colors ? "Colors (palette native)" : null;
		if (colors) acceptAccountPalette(accountId, colors);
		setPaletteReading(sequence, {
			accountId,
			status: colors ? "synced" : reason || value != null || (status !== null && status !== 200) ? "error" : "unavailable",
			source, format, native: native.state, httpStatus: status,
			reason: reason ?? (api ? null : value != null ? "Des valeurs de couleur ne sont pas reconnues."
				: status && status !== 200 ? "La lecture du compte a échoué."
				: "Aucune liste de couleurs dans la réponse du compte."),
		});
	}

	function recoverNativePalette(accountId) {
		if (!(accountId > 0) || accountColors?.accountId === accountId || paletteReading.status === "loading") return;
		const data = readGlobal("userData");
		const profile = normalizeUserId(data?.id) === accountId ? accountPalette(data) : null;
		const native = observeNativePalette(accountId, profile);
		const colors = profile ?? native.colors;
		if (colors) acceptAccountPalette(accountId, colors);
		setPaletteReading(paletteReading.sequence, {
			...paletteReading,
			...(colors ? { status: "synced", source: profile ? "Profil de la page" : "Colors (palette native)" } : {}),
			native: native.state,
		});
	}

	function parseBasePalette(source) {
		const literal = source.match(/^[ \t]*(?:let|const|var)[ \t]+Colors\s*=\s*\[([^\]]*)\]/m)?.[1];
		if (!literal) return null;
		const colors = literal.trim().replace(/,\s*$/, "").split(",").map((value) =>
			value.trim().match(/^(['"])(#[0-9a-f]{6}|#00000000)\1$/i)?.[2]);
		if (!colors.length || colors.some((color) => !color)) return null;
		return new Set(colors.map(toColorId).filter((color) => color !== -1));
	}

	async function loadBasePalette() {
		if (baseColors) return baseColors;
		if (baseColorsRequest) return baseColorsRequest;
		const script = Array.from(document.scripts ?? []).find(({ src }) => {
			if (!src) return false;
			const url = new URL(src, location.href);
			return url.origin === location.origin && url.pathname === "/js/index.js";
		});
		if (!script) return null;
		baseColorsRequest = (async () => {
			try {
				const response = await fetch(script.src, {
					credentials: "omit", signal: AbortSignal.timeout(PAINT_REQUEST_TIMEOUT_MS),
				});
				if (response.ok) baseColors = parseBasePalette(await response.text());
			} catch (error) {
				log("warn", "Palette de base GeoPixels indisponible.", error);
			}
			return baseColors;
		})();
		try {
			return await baseColorsRequest;
		} finally {
			baseColorsRequest = null;
		}
	}

	function getAuthPayload() {
		installPageBridge();
		let snapshot = {};
		try {
			snapshot = typeof win.__gpcAuthSnapshot === "function" ? win.__gpcAuthSnapshot() : {};
		} catch {}

		const userData = readGlobal("userData");
		const profileInput = document.getElementById("userID");
		const rawUserId =
			readGlobal("userID") ||
			snapshot.userID ||
			(userData && userData.id) ||
			(snapshot.userData && snapshot.userData.id) ||
			storageGet("userID") ||
			(profileInput && profileInput.value) ||
			"";
		const userId = normalizeUserId(rawUserId);
		const token = readGlobal("tokenUser") || snapshot.tokenUser || storageGet("tokenUser") || "";
		const cached = authCache && authCache.userId === userId &&
			(token === authCache.token || token === authCache.previousToken) ? authCache : null;
		return {
			token: cached ? cached.token : token,
			subject: readGlobal("subject") || snapshot.subject || (userData && userData.subject) || (snapshot.userData && snapshot.userData.subject) || (cached && cached.subject) || "",
			userId,
		};
	}

	async function getAuthPayloadAsync() {
		const current = getAuthPayload();
		if (current.token && current.subject && Number.isFinite(current.userId)) return current;
		if (!current.token || !Number.isFinite(current.userId)) return current;

		try {
			const response = await fetch("/TryLogIn", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: current.userId, token: String(current.token) }),
			});
			if (!response.ok) return current;

			const data = await response.json();
			const latest = getAuthPayload();
			if (latest.userId !== current.userId || latest.token !== current.token) return latest;

			authCache = {
				token: data.token || current.token,
				previousToken: current.token,
				subject: data.subject || current.subject || "",
				userId: normalizeUserId(data.id) || current.userId,
			};

			try {
				if (authCache.token) storageSet("tokenUser", authCache.token);
				if (authCache.userId) storageSet("userID", String(authCache.userId));
			} catch {}

			return {
				token: authCache.token,
				subject: authCache.subject,
				userId: authCache.userId,
			};
		} catch {
			return current;
		}
	}

	function pixelsFromUserData(data) {
		if (!data || !Number.isFinite(Number(data.pixels))) return null;
		return Math.max(0, Math.floor(Number(data.pixels) / 5));
	}

	function energyFromUserData(data, serverDate) {
		if (data?.energy == null || data.energy === "") return null;
		const energy = Math.floor(Number(data.energy));
		if (!Number.isSafeInteger(energy) || energy < 0) return null;
		const maxEnergy = Math.floor(Number(data.maxEnergy));
		const capacity = Number.isSafeInteger(maxEnergy) && maxEnergy > 0 ? maxEnergy : null;
		const rate = Number(data.energyRate);
		const tick = Number(data.checkedTick);
		const serverSeconds = Math.floor(Date.parse(serverDate) / 1000);
		const canEstimate = capacity !== null && energy < capacity &&
			Number.isFinite(rate) && rate > 0 && Number.isSafeInteger(tick) && tick > 0 &&
			serverSeconds >= tick;
		const current = canEstimate ? Math.min(capacity, energy + Math.floor((serverSeconds - tick) / rate)) : energy;
		return { current, capacity, rate };
	}

	function readCachedAvailablePixels() {
		const fromUserData = pixelsFromUserData(readGlobal("userData"));
		if (fromUserData !== null) return fromUserData;

		const captured = Number(win._gbUserPixels);
		if (Number.isFinite(captured) && captured >= 0) return Math.floor(captured / 5);

		const balance = document.getElementById("pixelBalance");
		if (balance) {
			const parsed = parseInt(balance.textContent.replace(/[^\d]/g, ""), 10);
			if (Number.isFinite(parsed)) return parsed;
		}
		return 0;
	}

	async function fetchAvailablePixels() {
		installPageBridge();
		if (typeof win.__gpcGetUserData === "function") {
			try {
				const result = await win.__gpcGetUserData();
				if (result && result.ok) {
					const pixels = pixelsFromUserData(result.data);
					if (pixels !== null) return pixels;
				}
			} catch {}
		}

		const auth = await getAuthPayloadAsync();
		if (!auth.token || !Number.isFinite(auth.userId)) return readCachedAvailablePixels();

		try {
			const response = await fetch("/GetUserData", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ userId: auth.userId, token: String(auth.token) }),
			});
			if (!response.ok) return readCachedAvailablePixels();

			const data = await response.json();
			const pixels = pixelsFromUserData(data);
			if (pixels !== null) return pixels;
		} catch {}

		return readCachedAvailablePixels();
	}

	async function fetchEnergySnapshot(showLoading = false) {
		installPageBridge();
		const auth = getAuthPayload();
		const accountId = auth.userId;
		const sequence = ++accountReadSequence;
		clearPreviousPalette(auth.token ? accountId : null);
		if (!auth.token || !(accountId > 0)) {
			const native = observeNativePalette(null);
			setPaletteReading(sequence, {
				accountId, status: "unavailable", source: null, format: null, native: native.state, httpStatus: null,
				reason: "Connectez-vous à GeoPixels, puis cliquez sur Actualiser.",
			});
			return { status: 401 };
		}
		const previousProfile = readGlobal("userData");
		if (showLoading || !accountColors) observeNativePalette(accountId);
		if (showLoading) {
			const sameAccount = paletteReading.accountId === accountId;
			setPaletteReading(sequence, {
				accountId, status: "loading", source: sameAccount ? paletteReading.source : null,
				format: null, native: null, httpStatus: null, reason: null,
			});
		}
		try {
			let result;
			if (typeof win.__gpcGetUserData === "function") result = await win.__gpcGetUserData();
			if (!result || result.needsSession) {
				const response = await fetch("/GetUserData", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ userId: auth.userId, token: String(auth.token) }),
					signal: AbortSignal.timeout(PAINT_REQUEST_TIMEOUT_MS),
				});
				result = {
					ok: response.ok,
					status: response.status,
					retryAfter: response.headers.get("Retry-After"),
					serverDate: response.headers.get("Date"),
					data: response.ok ? await response.json().catch(() => null) : null,
				};
			}
			const currentAccount = getAuthPayload().userId;
			if (accountId !== currentAccount) {
				setPaletteReading(sequence, {
					accountId, status: "unavailable", source: null, format: null, native: null, httpStatus: null,
					reason: "Le compte a changé. Cliquez sur Actualiser.",
				});
				return { status: 0 };
			}
			const validObject = result.data && typeof result.data === "object" && !Array.isArray(result.data);
			const matchingId = result.data?.id == null || normalizeUserId(result.data.id) === accountId;
			const data = result.ok && validObject && matchingId ? result.data : null;
			const reason = !result.status ? "La requête de lecture du compte a échoué."
				: result.ok && !validObject ? "La réponse du compte est illisible."
				: result.ok && !matchingId ? "La réponse correspond à un autre compte." : null;
			reportAccountPalette(accountId, sequence, data, result.status || null, previousProfile, reason);
			return {
				status: result.status,
				retryAfter: result.retryAfter,
				data,
				energy: energyFromUserData(data, result.serverDate),
			};
		} catch {
			reportAccountPalette(accountId, sequence, null, null, previousProfile, "La requête de lecture du compte a échoué.");
			return { status: 0 };
		}
	}

	async function connectAccountMonitor() {
		setStatus("syncing", "Connexion au moniteur local…");
		const popupName = "ghostpixel-monitor-connect";
		let popup = null;
		try {
			popup = win.open("about:blank", popupName, "popup,width=460,height=220");
			if (popup) {
				popup.document.title = "GhostPixel Monitor";
				popup.document.body.textContent = "Connexion à GhostPixel Monitor…";
			}
		} catch {}
		const auth = await getAuthPayloadAsync();
		if (!auth.token || !Number.isFinite(auth.userId)) {
			try { if (popup && !popup.closed) popup.close(); } catch {}
			setStatus("error", "Données du compte indisponibles. Actualisez la page ou reconnectez-vous.");
			return;
		}

		const data = JSON.stringify({ userId: auth.userId, token: String(auth.token) });
		try {
			await new Promise((resolve, reject) => {
				GM_xmlhttpRequest({
					method: "POST",
					url: ACCOUNT_MONITOR_URL,
					headers: {
						"Content-Type": "application/json",
						"X-GhostPixel-Monitor": "connect-v1",
					},
					data,
					timeout: 5000,
					onload: (response) => {
						let payload = {};
						try { payload = JSON.parse(response.responseText || "{}"); } catch {}
						if (response.status === 200 && payload?.ok !== false) {
							resolve();
							return;
						}
						const rejection = new Error(
							response.status === 200
								? "Le moniteur a refusé la connexion."
								: "Le moniteur a renvoyé le code HTTP " + response.status + "."
						);
						rejection.monitorResponse = true;
						reject(rejection);
					},
					onerror: () => reject(new Error("échec de la connexion")),
					onabort: () => reject(new Error("connexion annulée")),
					ontimeout: () => reject(new Error("délai dépassé")),
				});
			});
			try { if (popup && !popup.closed) popup.close(); } catch {}
			setStatus("done", "Moniteur connecté. Vous pouvez fermer le navigateur.");
		} catch (error) {
			if (error && error.monitorResponse) {
				try { if (popup && !popup.closed) popup.close(); } catch {}
				setStatus("error", error.message);
				return;
			}
			try {
				if (!popup || popup.closed) throw new Error("fenêtre auxiliaire bloquée");
				const form = popup.document.createElement("form");
				form.method = "POST";
				form.action = ACCOUNT_MONITOR_URL;
				form.enctype = "application/x-www-form-urlencoded";
				for (const [name, value] of Object.entries({
					channel: "connect-v1",
					userId: String(auth.userId),
					token: String(auth.token),
				})) {
					const input = popup.document.createElement("input");
					input.type = "hidden";
					input.name = name;
					input.value = value;
					form.appendChild(input);
				}
				popup.document.body.appendChild(form);
				form.submit();
				form.remove();
				setStatus("done", "Demande de connexion envoyée au moniteur. La fenêtre auxiliaire se fermera automatiquement.");
			} catch {
				setStatus("error", "Ouvrez GhostPixel Monitor et autorisez les fenêtres auxiliaires du navigateur.");
			}
		}
	}

	function normalizeArea(area, index = 0) {
		if (!area || typeof area !== "object") return null;
		if ([area.x1, area.y1, area.x2, area.y2].some((value) => value === null || value === undefined || String(value).trim() === "")) {
			return null;
		}
		const x1 = Number(area.x1);
		const y1 = Number(area.y1);
		const x2 = Number(area.x2);
		const y2 = Number(area.y2);
		if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
		return {
			id: String(area.id || (Date.now() + "-" + index)),
			mode: area.mode === "exclude" ? "exclude" : "include",
			x1: Math.trunc(Math.min(x1, x2)),
			y1: Math.trunc(Math.min(y1, y2)),
			x2: Math.trunc(Math.max(x1, x2)),
			y2: Math.trunc(Math.max(y1, y2)),
		};
	}

	function describeAreaPurchaseScope() {
		const areas = settings.areas || [];
		const inclusions = areas.filter((area) => area.mode === "include");
		const exclusions = areas.filter((area) => area.mode === "exclude");

		if (inclusions.length) {
			let description = inclusions.length === 1
				? "dans le rectangle vert"
				: "dans les " + inclusions.length + " rectangles verts";
			if (exclusions.length) {
				description += exclusions.length === 1
					? ", hors de la zone rouge"
					: ", hors des " + exclusions.length + " zones rouges";
			}
			return description;
		}

		if (exclusions.length) {
			return exclusions.length === 1
				? "hors du rectangle rouge"
				: "hors des " + exclusions.length + " rectangles rouges";
		}

		return "sur toute l’image";
	}

	function urlToString(input) {
		if (typeof input === "string") return input;
		if (input && typeof input.url === "string") return input.url;
		return "";
	}

	function parseRequestBody(init) {
		try {
			if (!init || typeof init.body !== "string") return null;
			return JSON.parse(init.body);
		} catch {
			return null;
		}
	}

	function installPurchaseObserver() {
		if (purchaseObserverInstalled) return;
		if (typeof win.fetch !== "function") throw new Error("La fonction fetch est indisponible sur la page.");

		originalFetch = win.fetch.bind(win);
		win.fetch = async function (input, init) {
			const requestUrl = urlToString(input);
			const body = parseRequestBody(init);
			const startedAt = Date.now();
			const response = await originalFetch(input, init);

			if (requestUrl.includes("MakePurchase")) {
				response.clone().text()
					.then((text) => {
						purchaseEvents.push({
							ok: response.ok,
							status: response.status,
							text,
							type: body && body.type,
							amount: body && body.amount,
							startedAt,
							at: Date.now(),
						});
						if (purchaseEvents.length > 30) purchaseEvents.splice(0, purchaseEvents.length - 30);
					})
					.catch(() => {});
			}

			return response;
		};
		purchaseObserverInstalled = true;
	}

	async function waitForPageFunction(name, timeoutMs = 10000) {
		const startedAt = Date.now();
		while (Date.now() - startedAt <= timeoutMs) {
			const fn = readGlobal(name);
			if (typeof fn === "function") return fn.bind(win);
			await delay(200);
		}
		throw new Error("Fonction GeoPixels indisponible : " + name);
	}

	function normalizeEndpointResult(result, extra = {}) {
		if (!result || typeof result !== "object") return null;
		const status = Number(result.status);
		return {
			ok: !!result.ok,
			status: Number.isFinite(status) ? status : 0,
			retryAfter: typeof result.retryAfter === "string" ? result.retryAfter : null,
			needsSession: result.needsSession === true,
			text: typeof result.text === "string" ? result.text : "",
			requestUncertain: result.requestUncertain === true,
			...extra,
		};
	}

	async function callPurchaseEndpoint(type, amount, { accountId, signal }) {
		const normalizedAmount = type === "ExtraColor" ? toColorId(amount) : amount;
		installPageBridge();
		if (signal.aborted || (accountId != null && state.stopRequested)) return { ok: false, notSent: true };
		if (typeof win.__gpcMakePurchase === "function") {
			try {
				const result = normalizeEndpointResult(
					await win.__gpcMakePurchase(type, normalizedAmount, accountId),
					{ type, amount: normalizedAmount }
				);
				if (!result) return { ok: false, status: 0, requestUncertain: true };
				if (!result.needsSession) return result;
			} catch (error) {
				return {
					ok: false,
					status: 0,
					text: error && error.message ? error.message : String(error),
					requestUncertain: true,
					type,
					amount: normalizedAmount,
				};
			}
		}

		const auth = await getAuthPayloadAsync();
		if (signal.aborted || (accountId != null && (state.stopRequested || auth.userId !== accountId))) {
			return { ok: false, notSent: true };
		}
		if (!auth.token || !auth.subject || !Number.isFinite(auth.userId)) {
			return {
				ok: false,
				status: 0,
				notSent: true,
				text: "Session GeoPixels incomplète. Reconnectez-vous avant d’effectuer un achat.",
				type,
				amount: normalizedAmount,
			};
		}

		const payload = {
			Token: String(auth.token),
			UserId: auth.userId,
			Subject: String(auth.subject),
			type,
			amount: normalizedAmount,
		};

		const response = await fetch("/MakePurchase", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal,
		});

		return {
			ok: response.ok,
			status: response.status,
			retryAfter: response.headers.get("Retry-After"),
			text: await response.text(),
			type,
			amount,
		};
	}

	async function waitForPurchaseResult(type, amount, startedAt) {
		const deadline = Date.now() + PURCHASE_RESULT_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const result = purchaseEvents.find((event) => {
				if (event.startedAt < startedAt - 50) return false;
				if (event.type && event.type !== type) return false;
				if (event.amount && amount && event.amount !== amount) return false;
				return true;
			});
			if (result) return result;
			await delay(200);
		}

		return {
			ok: false,
			status: 0,
			text: "Aucune réponse reçue pour l’achat.",
			type,
			amount,
		};
	}

	async function callPagePurchase(type, amount, accountId = null) {
		if (purchaseInFlight) return { ok: false, notSent: true };
		purchaseInFlight = true;
		try {
			return await dispatchPurchase(type, amount, accountId);
		} finally {
			purchaseInFlight = false;
		}
	}

	async function dispatchPurchase(type, amount, accountId) {
		let direct;
		try {
			const signal = AbortSignal.timeout(PURCHASE_RESULT_TIMEOUT_MS);
			direct = await withTimeout(
				callPurchaseEndpoint(type, amount, { accountId, signal }),
				PURCHASE_RESULT_TIMEOUT_MS,
				"Délai d’attente dépassé. Vérifiez le résultat de l’achat avant de réessayer."
			);
		} catch (error) {
			return {
				ok: false,
				status: 0,
				requestUncertain: true,
				text: error && error.message ? error.message : "Délai d’attente dépassé pour l’achat.",
				type,
				amount,
			};
		}
		if (accountId !== null || !direct.notSent) return direct;

		installPurchaseObserver();
		try {
			const makePurchase = await waitForPageFunction("MakePurchase", 1500);
			const startedAt = Date.now();
			const returned = await withTimeout(
				makePurchase(type, amount),
				PURCHASE_RESULT_TIMEOUT_MS,
				"Délai d’attente dépassé. Vérifiez le résultat de l’achat avant de réessayer."
			);
			if (returned && typeof returned === "object" && "ok" in returned) return returned;
			const observed = await waitForPurchaseResult(type, amount, startedAt);
			if (observed && observed.status !== 0) return observed;
		} catch {}
		return { ok: false, status: 0, requestUncertain: true };
	}

	function getGhostSource() {
		const imageData = readGlobal("ghostImageOriginalData");
		const topLeft = readGlobal("ghostImageTopLeft");
		if (!imageData || !imageData.data || !topLeft) return null;

		const gridX = Number(topLeft.gridX ?? topLeft.x);
		const gridY = Number(topLeft.gridY ?? topLeft.y);
		if (!Number.isFinite(gridX) || !Number.isFinite(gridY)) return null;

		return { imageData, gridX, gridY };
	}

	function settingsSignature() {
		return [
			settings.includeFreeColors, settings.includeTransparent, settings.onlyPriorityColors,
			settings.ignoredColors.join("."), settings.priorityColors.join("."),
			settings.areas.map((area) => [area.mode, area.x1, area.y1, area.x2, area.y2].join(",")).join(";"),
		].join("|");
	}

	function invalidateTargets() {
		// Les filtres et la palette changent la sélection, les observations restent valables pour le même modèle.
		targetRevision++;
		targetCache = null;
		purchaseTargetCache = null;
		state.remaining = 0;
	}

	function sameGhost(model, source) {
		return model && source && model.imageData === source.imageData &&
			model.gridX === source.gridX && model.gridY === source.gridY;
	}

	async function yieldWork() {
		await delay(0);
		if (state.stopRequested) throw new Error("Arrêté");
	}

	function analyzeImage(imageData) {
		if (imageAnalysis?.imageData !== imageData) {
			imageAnalysis = { imageData, pixels: decodeImageColors(imageData), histogram: null };
		}
		return imageAnalysis;
	}

	async function decodeImageColors(imageData) {
		const { width, data } = imageData;
		const height = data.length / (4 * width);
		if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
			throw new Error("Dimensions du modèle invalides.");
		}
		const length = width * height;
		const colors = new Int32Array(length);
		for (let start = 0; start < length; start += WORK_CHUNK) {
			const end = Math.min(start + WORK_CHUNK, length);
			for (let index = start; index < end; index++) {
				const offset = index * 4;
				colors[index] = data[offset + 3] === 0 ? -1 :
					(data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
			}
			if (end < length) await delay(0);
		}
		return { width, height, colors };
	}

	async function analyzeGhost(source) {
		const { imageData, gridX, gridY } = source;
		if (!Number.isSafeInteger(gridX) || !Number.isSafeInteger(gridY)) {
			throw new Error("Coordonnées du modèle invalides.");
		}
		const { width, height, colors } = await analyzeImage(imageData).pixels;
		const observed = new Int32Array(colors.length);
		for (let start = 0; start < colors.length; start += WORK_CHUNK) {
			const end = Math.min(start + WORK_CHUNK, colors.length);
			observed.fill(UNKNOWN_COLOR, start, end);
			if (end < colors.length) await yieldWork();
		}
		const west = tileOrigin(gridX);
		const north = tileOrigin(gridY);
		const tiles = [];
		const tilesByKey = new Map();
		const columns = 1 + (tileOrigin(gridX + width - 1) - west) / TILE_SIZE;
		for (let y = north; y >= tileOrigin(gridY - height + 1); y -= TILE_SIZE) {
			for (let x = west; x <= tileOrigin(gridX + width - 1); x += TILE_SIZE) {
				const left = Math.max(0, x - gridX);
				const right = Math.min(width, x + TILE_SIZE - gridX);
				const top = Math.max(0, gridY - (y + TILE_SIZE - 1));
				const bottom = Math.min(height, gridY - y + 1);
				const tile = { x, y, left, right, top, bottom, timestamp: 0, unknown: (right - left) * (bottom - top) };
				tiles.push(tile);
				tilesByKey.set(tileKey(x, y), tile);
			}
		}
		return { ...source, width, height, colors, observed, tiles, tilesByKey, columns, west, north };
	}

	function modelTile(model, col, row) {
		const x = Math.floor((model.gridX + col - model.west) / TILE_SIZE);
		const y = -Math.floor((model.gridY - row - model.north) / TILE_SIZE);
		return model.tiles[y * model.columns + x];
	}

	async function sortTargetKeys(indices, keys, scratch) {
		// Chaque passage stable conserve l’ordre des critères déjà traités.
		const first = keys[indices[0]];
		let varying = 0;
		for (let index = 1; index < indices.length; index++) {
			varying |= first ^ keys[indices[index]];
			if (index % WORK_CHUNK === 0) await yieldWork();
		}
		for (let shift = 0; shift < 32; shift += 8) {
			if (!((varying >>> shift) & 255)) continue;
			const offsets = new Uint32Array(256);
			for (let index = 0; index < indices.length; index++) {
				offsets[(keys[indices[index]] >>> shift) & 255]++;
				if ((index + 1) % WORK_CHUNK === 0) await yieldWork();
			}
			let total = 0;
			for (let bucket = 0; bucket < offsets.length; bucket++) {
				const count = offsets[bucket];
				offsets[bucket] = total;
				total += count;
			}
			for (let index = 0; index < indices.length; index++) {
				const pixel = indices[index];
				scratch[offsets[(keys[pixel] >>> shift) & 255]++] = pixel;
				if ((index + 1) % WORK_CHUNK === 0) await yieldWork();
			}
			[indices, scratch] = [scratch, indices];
		}
		return [indices, scratch];
	}

	async function measureRegions(model, indices, ranks) {
		const { width, colors } = model;
		const regions = new Uint32Array(colors.length);
		const queue = new Uint32Array(indices.length);
		let size = 0;
		let work = 0;
		let color = 0;
		const add = (index) => {
			if (ranks[index] && !regions[index] && colors[index] === color) {
				regions[index] = 1;
				queue[size++] = index;
			}
		};
		for (let rank = 0; rank < indices.length; rank++) {
			const root = indices[rank];
			if (regions[root]) {
				if (++work % WORK_CHUNK === 0) await yieldWork();
				continue;
			}
			color = colors[root];
			size = 0;
			add(root);
			for (let index = 0; index < size; index++) {
				const pixel = queue[index];
				const col = pixel % width;
				if (col > 0) add(pixel - 1);
				if (col + 1 < width) add(pixel + 1);
				add(pixel - width);
				add(pixel + width);
				if (++work % WORK_CHUNK === 0) await yieldWork();
			}
			for (let index = 0; index < size; index++) {
				regions[queue[index]] = size;
				if (++work % WORK_CHUNK === 0) await yieldWork();
			}
		}
		return regions;
	}

	async function fillTargetKeys(indices, keys, keyOf) {
		for (let index = 0; index < indices.length; index++) {
			const pixel = indices[index];
			keys[pixel] = keyOf(pixel);
			if ((index + 1) % WORK_CHUNK === 0) await yieldWork();
		}
	}

	async function radialTargetKeys(indices, width, keys, outsideFirst) {
		const { floor } = Math;
		let left = width;
		let right = 0;
		let top = floor(indices[0] / width);
		let bottom = top;
		for (let index = 0; index < indices.length; index++) {
			const pixel = indices[index];
			const col = pixel % width;
			const row = floor(pixel / width);
			if (col < left) left = col;
			if (col > right) right = col;
			if (row < top) top = row;
			if (row > bottom) bottom = row;
			if ((index + 1) % WORK_CHUNK === 0) await yieldWork();
		}

		const maxDistance = (right - left) ** 2 + (bottom - top) ** 2;
		const highKeys = maxDistance >= 0x100000000 ? new Uint32Array(keys.length) : null;
		// Les coordonnées doublées gardent les centres entre deux pixels sans fraction.
		await fillTargetKeys(indices, keys, (pixel) => {
			const dx = 2 * (pixel % width) - left - right;
			const dy = 2 * floor(pixel / width) - top - bottom;
			const distance = dx * dx + dy * dy;
			const key = outsideFirst ? maxDistance - distance : distance;
			if (highKeys) highKeys[pixel] = floor(key / 0x100000000);
			return key;
		});
		return highKeys;
	}

	function contourKey(pixel, width, colors, ranks) {
		const col = pixel % width;
		if (col === 0 || col === width - 1 || pixel < width || pixel >= colors.length - width) return 0;
		const color = colors[pixel];
		return ranks[pixel - 1] && ranks[pixel + 1] && ranks[pixel - width] && ranks[pixel + width] &&
			colors[pixel - 1] === color && colors[pixel + 1] === color &&
			colors[pixel - width] === color && colors[pixel + width] === color ? 1 : 0;
	}

	async function orderTargetIndices(model, indices, ranks, frequencies, priority, strategy, seed) {
		if (indices.length < 2) return indices;
		if (strategy === "random") {
			// Fisher–Yates par blocs, avec une graine persistante.
			const { imul, floor } = Math;
			let value = seed;
			for (let index = indices.length - 1; index > 0; index--) {
				value = (imul(value, 1664525) + 1013904223) >>> 0;
				const other = floor(value * (index + 1) / 0x100000000);
				const pixel = indices[index];
				indices[index] = indices[other];
				indices[other] = pixel;
				if (index % WORK_CHUNK === 0) await yieldWork();
			}
		}
		if ((strategy === "top-down" || strategy === "random") && !priority.size) return indices;

		const { width, height, colors } = model;
		let scratch = new Uint32Array(indices.length);
		const keys = new Uint32Array(colors.length);
		if (strategy === "smart") {
			if (frequencies.size > 1) {
				await fillTargetKeys(indices, keys, (pixel) => frequencies.get(colors[pixel]));
				[indices, scratch] = await sortTargetKeys(indices, keys, scratch);
			}
			const regions = await measureRegions(model, indices, ranks);
			[indices, scratch] = await sortTargetKeys(indices, regions, scratch);
		} else if (strategy === "color" && frequencies.size > 1) {
			const colorsByRarity = [...frequencies].sort(([idA, countA], [idB, countB]) => countA - countB || idA - idB);
			const colorOrder = new Map(colorsByRarity.map(([color], rank) => [color, rank]));
			await fillTargetKeys(indices, keys, (pixel) => colorOrder.get(colors[pixel]));
			[indices, scratch] = await sortTargetKeys(indices, keys, scratch);
		} else if (strategy === "center-out" || strategy === "outside-in") {
			const highKeys = await radialTargetKeys(indices, width, keys, strategy === "outside-in");
			[indices, scratch] = await sortTargetKeys(indices, keys, scratch);
			if (highKeys) [indices, scratch] = await sortTargetKeys(indices, highKeys, scratch);
		} else {
			const spatialKey = {
				"bottom-up": (pixel) => height - 1 - Math.floor(pixel / width),
				"left-right": (pixel) => pixel % width,
				"right-left": (pixel) => width - 1 - (pixel % width),
				contours: (pixel) => contourKey(pixel, width, colors, ranks),
			}[strategy];
			if (spatialKey) {
				await fillTargetKeys(indices, keys, spatialKey);
				[indices, scratch] = await sortTargetKeys(indices, keys, scratch);
			}
		}
		if (priority.size) {
			// Le tri stable donne la priorité aux couleurs choisies tout en conservant la stratégie dans chaque groupe.
			await fillTargetKeys(indices, keys, (pixel) => priority.get(colors[pixel]) ?? priority.size);
			[indices] = await sortTargetKeys(indices, keys, scratch);
		}
		return indices;
	}

	function pixelStatus(expected, observed) {
		if (observed === UNKNOWN_COLOR) return PIXEL_UNKNOWN;
		if (observed === expected) return PIXEL_CORRECT;
		return observed === -1 ? PIXEL_EMPTY : PIXEL_WRONG;
	}

	function countPixel(cache, rank, color, classification, change) {
		cache.counts[classification] += change;
		if (cache.monitor) return;
		if (classification !== PIXEL_WRONG && classification !== PIXEL_EMPTY) return;
		if (cache.missingByColor) {
			const count = (cache.missingByColor.get(color) ?? 0) + change;
			if (count) cache.missingByColor.set(color, count);
			else cache.missingByColor.delete(color);
			return;
		}
		const word = rank >>> 5;
		const bit = 1 << (rank & 31);
		if (change > 0) {
			cache.pending[word] |= bit;
			if (word < cache.firstPending) cache.firstPending = word;
			if (classification === PIXEL_WRONG) {
				cache.wrong[word] |= bit;
				if (word < cache.firstWrong) cache.firstWrong = word;
			}
		} else {
			cache.pending[word] &= ~bit;
			cache.wrong[word] &= ~bit;
		}
	}

	async function buildTargets(options = {}) {
		const source = getGhostSource();
		if (!source) throw new Error("Chargez et positionnez une image fantôme dans GeoPixels.");
		if (!settings.includeFreeColors && !baseColors && !await loadBasePalette()) {
			throw new Error("La palette de base est indisponible. Le filtre des couleurs de base ne peut pas être appliqué.");
		}
		const revision = targetRevision;
		if (!sameGhost(modelCache, source)) {
			const model = await analyzeGhost(source);
			if (revision !== targetRevision || !sameGhost(model, getGhostSource())) return buildTargets(options);
			modelCache = model;
			invalidateTargets();
			return buildTargets(options);
		}

		const model = modelCache;
		const filter = settings;
		const orderTargets = !options.onlyUnowned && !options.monitor;
		const { drawingStrategy, drawingSeed } = filter;
		const owned = options.monitor ? null : options.owned || getOwnedColorIds();
		if (!options.monitor && !owned) throw new Error("La palette du compte GeoPixels est indisponible. Ouvrez « Palette et filtres » puis cliquez sur Actualiser.");
		const paletteKey = owned ? [...owned].sort((a, b) => a - b).join(",") : "?";
		const orderKey = orderTargets ? drawingStrategy + (drawingStrategy === "random" ? ":" + drawingSeed : "") : "";
		const key = settingsSignature() + "|" + (options.monitor ? "monitor" : paletteKey) + "|" + orderKey;
		const existing = options.onlyUnowned ? purchaseTargetCache : targetCache;
		if (existing?.model === model && existing.key === key) return existing;

		const { colors, width, gridX, gridY } = model;
		const ignored = new Set(filter.ignoredColors);
		const priority = new Map(filter.priorityColors.map((id, rank) => [id, rank]));
		const exclusive = filter.onlyPriorityColors;
		const skipBase = !filter.includeFreeColors;
		const includes = filter.areas.filter((area) => area.mode === "include");
		const excludes = filter.areas.filter((area) => area.mode === "exclude");
		const inside = (area, x, y) => x >= area.x1 && x <= area.x2 && y >= area.y1 && y <= area.y2;
		const ranks = new Uint32Array(colors.length);
		const frequencies = new Map();
		const activeTiles = new Set();
		const unordered = new Uint32Array(colors.length);
		let count = 0;
		let index = 0;
		for (let row = 0; row < model.height; row++) {
			const y = gridY - row;
			const tileRow = -Math.floor((y - model.north) / TILE_SIZE) * model.columns;
			let tileColumn = 0;
			let tile = model.tiles[tileRow];
			let tileSelected = false;
			for (let col = 0; col < width; col++, index++) {
				if (index && index % WORK_CHUNK === 0) await yieldWork();
				if (col === tile.right) {
					tile = model.tiles[tileRow + ++tileColumn];
					tileSelected = false;
				}
				const color = colors[index];
				if ((color === -1 && !filter.includeTransparent) || (skipBase && baseColors.has(color)) ||
					ignored.has(color) || (exclusive && !priority.has(color))) continue;
				if (options.onlyUnowned ? color === -1 || owned.has(color) : owned && color !== -1 && !owned.has(color)) continue;
				const x = gridX + col;
				if ((includes.length && !includes.some((area) => inside(area, x, y))) ||
					(excludes.length && excludes.some((area) => inside(area, x, y)))) continue;
				if (!tileSelected) {
					activeTiles.add(tile);
					tileSelected = true;
				}
				unordered[count++] = index;
				ranks[index] = 1;
				if (!options.onlyUnowned) frequencies.set(color, (frequencies.get(color) ?? 0) + 1);
			}
		}

		let indices = count === unordered.length ? unordered : unordered.slice(0, count);
		if (orderTargets) indices = await orderTargetIndices(model, indices, ranks, frequencies, priority, drawingStrategy, drawingSeed);

		const words = Math.ceil(count / 32);
		// Un bit par rang représente un pixel observé à peindre. Les compteurs n’ont pas besoin de parcourir ces listes.
		const cache = {
			model, key, indices, ranks: count ? ranks : new Uint32Array(0),
			tiles: [...activeTiles], counts: [0, 0, 0, 0], frequencies,
			monitor: options.monitor === true,
			pending: new Uint32Array(orderTargets ? words : 0),
			wrong: new Uint32Array(orderTargets ? words : 0),
			firstPending: words, firstWrong: words,
			missingByColor: options.onlyUnowned ? new Map() : null,
		};
		for (let rank = 0; rank < count; rank++) {
			const index = indices[rank];
			ranks[index] = rank + 1;
			countPixel(cache, rank, colors[index], pixelStatus(colors[index], model.observed[index]), 1);
			if ((rank + 1) % WORK_CHUNK === 0) await yieldWork();
		}
		if (revision !== targetRevision || !sameGhost(model, getGhostSource())) return buildTargets(options);
		if (options.onlyUnowned) purchaseTargetCache = cache;
		else targetCache = cache;
		return cache;
	}

	async function getMissingRequiredColors(owned = getOwnedColorIds()) {
		if (!owned) throw new Error("GeoPixels charge encore la liste des couleurs achetées.");
		const options = { onlyUnowned: true, silent: true, owned };
		const cache = await buildTargets(options);
		await syncBoard(options, cache);
		const unknown = cache.counts[PIXEL_UNKNOWN];
		if (unknown) throw new Error("Impossible de vérifier " + numberFormat.format(unknown) + " pixel(s) sur la carte.");
		return [...cache.missingByColor.keys()].sort((a, b) => a - b);
	}


	function automaticPurchaseLedgerKey(accountId) {
		return SETTINGS_KEY + "_purchases_" + accountId;
	}

	function sameAutomaticPurchaseSettings(config) {
		return JSON.stringify(loadSettings().automaticPurchases) === JSON.stringify(config);
	}

	function readAutomaticPurchaseLedger(accountId) {
		const raw = storageGet(automaticPurchaseLedgerKey(accountId));
		const ledger = JSON.parse(raw ?? '{"spent":0,"pending":null}');
		if (!Number.isSafeInteger(ledger?.spent) || ledger.spent < 0) throw new Error("Historique des achats illisible.");
		return ledger;
	}

	function writeAutomaticPurchaseLedger(accountId, ledger) {
		const key = automaticPurchaseLedgerKey(accountId);
		const value = JSON.stringify(ledger);
		storageSet(key, value);
		if (storageGet(key) !== value) throw new Error("Impossible d’enregistrer l’achat dans le navigateur.");
	}

	function automaticBalance(data) {
		if (data?.pixels == null || data.pixels === "") return null;
		const balance = Number(data.pixels);
		return Number.isSafeInteger(balance) && balance >= 0 ? balance : null;
	}

	function normalizeAccountColors(raw) {
		const values = Array.isArray(raw) ? raw : typeof raw === "string" && raw.trim() ? raw.split(",") : null;
		if (!values) return null;
		const colors = new Set();
		for (const value of values) {
			let id = value;
			if (typeof value === "string") {
				const text = value.trim();
				if (/^(?:#00000000|#0000-1|transparent)$/i.test(text)) continue;
				const hex = text.match(/^(?:#|0x)([0-9a-f]{6})$/i)?.[1] ??
					(/^[0-9a-f]{6}$/i.test(text) && /[a-f]/i.test(text) ? text : null);
				id = hex ? Number.parseInt(hex, 16) : /^-?\d+$/.test(text) ? Number(text) : null;
			}
			if (!Number.isInteger(id) || id < -1 || id > 0xFFFFFF) return null;
			if (id !== -1) colors.add(id);
		}
		return colors;
	}

	function accountPalette(data) {
		return normalizeAccountColors(data?.colors);
	}

	function readUpgradeTariff(type, colorCount) {
		const upgrade = AUTO_UPGRADES[type];
		const card = document.getElementById(upgrade.input)?.parentElement?.parentElement;
		const matches = Array.from(card?.children || [], (child) => child.textContent?.trim().match(upgrade.tariff)).filter(Boolean);
		if (matches.length !== 1 || !Number.isSafeInteger(Number(matches[0][1]) * 5)) return null;
		const [, cost, minimum] = matches[0];
		const free = type === "ExtraColor" && Number.isInteger(colorCount) &&
			document.getElementById("freeColorNotice") && colorCount + 1 < FREE_COLOR_PALETTE_LIMIT;
		return { cost: free ? 0 : Number(cost), minimum: Number(minimum) };
	}

	function updateAutomaticPurchases(message, next = "") {
		autoPurchases.message = message;
		autoPurchases.next = next;
		renderAutomaticPurchases();
	}

	function confirmAutomaticPurchase(pending, reading) {
		if (pending.accepted !== true) return false;
		if (automaticBalance(reading.data) !== pending.balance - pending.cost * 5) return false;
		const energy = reading.energy;
		switch (pending.type) {
			case "FasterRecharge": return energy?.rate === pending.before - 1;
			case "EnergyCapacity": return energy?.capacity === pending.before + 5;
			case "Energy": return energy != null && energy.current >= pending.before + 20;
			case "ExtraColor": return accountPalette(reading.data)?.has(pending.amount) === true;
			default: return false;
		}
	}

	function recordAutomaticPurchase(accountId, ledger) {
		const pending = ledger.pending;
		const spent = ledger.spent + pending.cost;
		writeAutomaticPurchaseLedger(accountId, { spent, pending: null });
		autoPurchases.spent = spent;
		return pending.type === "ExtraColor";
	}

	async function checkAutomaticPurchases(hasPendingPixels, accountId, config) {
		const reading = await fetchEnergySnapshot();
		const outcome = { reading, purchased: false, colorsChanged: false, colorsOutstanding: false };
		const balance = automaticBalance(reading.data);
		autoPurchases.balance = balance === null ? null : Math.floor(balance / 5);
		if (state.stopRequested || getAuthPayload().userId !== accountId) return outcome;
		if (!sameAutomaticPurchaseSettings(config)) {
			updateAutomaticPurchases("Réglages modifiés dans un autre onglet. Rechargez la page.");
			return outcome;
		}
		const ledger = readAutomaticPurchaseLedger(accountId);
		autoPurchases.spent = ledger.spent;
		if (ledger.pending) {
			if (confirmAutomaticPurchase(ledger.pending, reading)) {
				outcome.colorsChanged = recordAutomaticPurchase(accountId, ledger);
				updateAutomaticPurchases("Achat précédent confirmé par le compte.");
			} else {
				updateAutomaticPurchases("Achat précédent non confirmé. Achats automatiques suspendus.");
				outcome.colorsOutstanding = ledger.pending.type === "ExtraColor";
			}
			return outcome;
		}
		if (balance === null || !reading.energy) {
			updateAutomaticPurchases("Données du compte indisponibles.");
			return outcome;
		}
		if (Date.now() < Math.max(autoPurchases.retryAt, ledger.retryAt || 0)) {
			renderAutomaticPurchases();
			return outcome;
		}

		const energy = reading.energy;
		const palette = accountPalette(reading.data);
		let purchase;
		let colorSource;
		let colorSignature;
		for (const type of config.order) {
			if (!config.enabled.includes(type) || (!hasPendingPixels && type !== "ExtraColor")) continue;
			const quote = readUpgradeTariff(type, palette?.size);
			if (!quote || (type === "ExtraColor" && !palette)) {
				updateAutomaticPurchases("Tarif ou disponibilité non vérifiable.", AUTO_UPGRADES[type].label);
				return outcome;
			}
			let amount = 1;
			let before = null;
			if (type === "FasterRecharge") {
				if (!Number.isInteger(energy.rate) || energy.rate <= 0) continue;
				if (energy.rate - 1 < quote.minimum) continue;
				before = energy.rate;
			} else if (type === "EnergyCapacity") {
				if (energy.capacity === null) continue;
				before = energy.capacity;
			} else if (type === "Energy") {
				before = energy.current;
			} else {
				colorSource = getGhostSource();
				colorSignature = settingsSignature();
				try {
					[amount] = await getMissingRequiredColors(palette);
				} catch (error) {
					autoPurchases.retryAt = Date.now() + EMPTY_ENERGY_PAUSE_MIN_MS;
					updateAutomaticPurchases(error.message, AUTO_UPGRADES[type].label);
					return outcome;
				}
				if (amount === undefined) continue;
				outcome.colorsOutstanding = true;
			}
			purchase = { type, amount, before, balance, cost: quote.cost };
			break;
		}

		if (!purchase) {
			updateAutomaticPurchases("Aucune amélioration disponible ou nécessaire.");
			return outcome;
		}
		const label = purchase.type === "ExtraColor" ? "Couleur " + colorHex(purchase.amount) : AUTO_UPGRADES[purchase.type].label;
		const next = label + " · " + purchase.cost + " Pixels";
		if (purchase.cost > Math.max(0, autoPurchases.balance - config.reserve)) {
			updateAutomaticPurchases("Solde insuffisant après déduction de la réserve.", next);
			return outcome;
		}
		if (config.policy === "limited" && purchase.cost > Math.max(0, config.limit - ledger.spent)) {
			updateAutomaticPurchases("Plafond cumulé des achats automatiques atteint.", next);
			return outcome;
		}
		if (purchase.type === "ExtraColor") {
			outcome.reading = await fetchEnergySnapshot();
			const refreshedPalette = accountPalette(outcome.reading.data);
			const refreshedTariff = readUpgradeTariff(purchase.type, refreshedPalette?.size);
			if (automaticBalance(outcome.reading.data) !== balance || !refreshedPalette ||
				refreshedPalette.has(purchase.amount) || refreshedTariff?.cost !== purchase.cost) {
				updateAutomaticPurchases("Le solde ou la palette a changé. Nouvelle vérification requise.", next);
				return outcome;
			}
			const current = getGhostSource();
			if (current?.imageData !== colorSource?.imageData || current?.gridX !== colorSource?.gridX ||
				current?.gridY !== colorSource?.gridY || settingsSignature() !== colorSignature) return outcome;
		}
		if (state.stopRequested || getAuthPayload().userId !== accountId || !sameAutomaticPurchaseSettings(config)) return outcome;
		writeAutomaticPurchaseLedger(accountId, { ...ledger, pending: purchase });
		updateAutomaticPurchases("Achat en cours de vérification…", next);
		const result = await callPagePurchase(purchase.type, purchase.amount, accountId);
		if (result.notSent || [401, 402, 429].includes(result.status)) {
			const delayMs = result.status === 429 ? rateLimitDelay(result.retryAfter) : EMPTY_ENERGY_PAUSE_MIN_MS;
			autoPurchases.retryAt = Math.min(Number.MAX_SAFE_INTEGER, Date.now() + delayMs);
			writeAutomaticPurchaseLedger(accountId, result.status === 429 ? { ...ledger, retryAt: autoPurchases.retryAt } : ledger);
			updateAutomaticPurchases(result.status ? "Achat refusé par GeoPixels (HTTP " + result.status + ")." : "Achat interrompu avant l’envoi.", next);
			return outcome;
		}

		if (result.status === 200) {
			purchase.accepted = true;
			writeAutomaticPurchaseLedger(accountId, { ...ledger, pending: purchase });
		}
		outcome.reading = await fetchEnergySnapshot();
		const afterBalance = automaticBalance(outcome.reading.data);
		autoPurchases.balance = afterBalance === null ? null : Math.floor(afterBalance / 5);
		if (getAuthPayload().userId !== accountId || !confirmAutomaticPurchase(purchase, outcome.reading)) {
			const detail = result.status && result.status !== 200 ? " (HTTP " + result.status + ")" : "";
			updateAutomaticPurchases("Résultat non confirmé" + detail + ". Achats suspendus jusqu’à vérification du compte.", next);
			return outcome;
		}
		outcome.colorsChanged = recordAutomaticPurchase(accountId, { ...ledger, pending: purchase });
		outcome.purchased = true;
		updateAutomaticPurchases(label + " confirmé.");
		return outcome;
	}

	async function runAutomaticPurchases(hasPendingPixels) {
		const config = settings.automaticPurchases;
		if (config.policy === "off" || !config.enabled.length) return null;
		const accountId = getAuthPayload().userId;
		if (config.accountId === null || config.accountId !== accountId) {
			updateAutomaticPurchases("Autorisation requise pour ce compte.");
			return null;
		}
		const locks = window.navigator?.locks;
		if (!locks) {
			updateAutomaticPurchases("Verrou inter-onglets indisponible dans le navigateur.");
			return null;
		}
		try {
			return await locks.request(automaticPurchaseLedgerKey(accountId), { ifAvailable: true }, async (lock) => {
				if (lock) return checkAutomaticPurchases(hasPendingPixels, accountId, config);
				updateAutomaticPurchases("Achats automatiques en cours dans un autre onglet.");
				return null;
			});
		} catch (error) {
			log("warn", "Achats automatiques bloqués.", error);
			updateAutomaticPurchases("Vérification des achats indisponible. Consultez le journal du navigateur.");
			return null;
		}
	}

	function prepareCompletionNotifications() {
		try {
			if (
				typeof GM_notification === "function" ||
				(typeof GM !== "undefined" && typeof GM.notification === "function")
			) {
				return;
			}
			if (typeof Notification !== "undefined" && Notification.permission === "default") {
				const permissionRequest = Notification.requestPermission();
				if (permissionRequest && typeof permissionRequest.catch === "function") {
					permissionRequest.catch((error) => log("warn", "Impossible de demander l’autorisation d’afficher des notifications.", error));
				}
			}
		} catch (error) {
			log("warn", "Impossible de préparer les notifications.", error);
		}
	}

	function notifyCompletion() {
		if (completionNotificationSent || !hadPendingTargets) return;
		completionNotificationSent = true;

		const title = "GhostPixel · Peinture terminée";
		const text = "Tous les pixels sélectionnés de l’image sont terminés.";
		const focusPage = () => {
			try { window.focus(); } catch {}
		};

		try {
			if (typeof GM_notification === "function") {
				GM_notification({ title, text, timeout: 12000, onclick: focusPage });
				return;
			}
			if (typeof GM !== "undefined" && typeof GM.notification === "function") {
				Promise.resolve(GM.notification({ title, text, timeout: 12000, onclick: focusPage }))
					.catch((error) => log("warn", "Impossible d’afficher la notification.", error));
				return;
			}
			if (typeof Notification !== "undefined" && Notification.permission === "granted") {
				const notification = new Notification(title, { body: text });
				notification.onclick = () => {
					focusPage();
					notification.close();
				};
				setTimeout(() => notification.close(), 12000);
				return;
			}
			log("warn", "Peinture terminée. Autorisez les notifications pour recevoir une alerte.");
		} catch (error) {
			log("warn", "Impossible d’afficher la notification.", error);
		}
	}

	async function buyColor(colorId) {
		colorId = toColorId(colorId);
		if (colorId === null || colorId === -1) throw new Error("Couleur invalide pour l’achat.");
		const hex = colorHex(colorId);
		const accountId = getAuthPayload().userId;
		if (getOwnedColorIds()?.has(colorId)) return true;
		setStatus("buying", "Achat de la couleur " + hex + "...");
		const result = await callPagePurchase("ExtraColor", hex);
		if (result.status === 402) return "insufficient";
		if (!result.ok) {
			log("warn", "Échec de l’achat de la couleur", hex, result.status, result.text);
			return false;
		}

		const reading = await fetchEnergySnapshot();
		if (getAuthPayload().userId !== accountId || !accountPalette(reading.data)?.has(colorId)) {
			setStatus("error", "Achat reçu, mais " + hex + " reste non vérifiée sur le compte.");
			return false;
		}
		return true;
	}

	async function buyEnergyCapacity(amount = 1) {
		amount = clampPositiveInt(amount, 1);
		let remaining = amount;
		let bought = 0;
		let chunkSize = Math.min(remaining, ENERGY_CAPACITY_PURCHASE_CHUNK);
		let latestEnergy = null;

		while (remaining > 0) {
			const chunkAmount = Math.min(remaining, chunkSize);
			setStatus(
				"buying",
				"Achat de capacité d’énergie " + bought + "/" + amount + "..."
			);

			const result = await callPagePurchase("EnergyCapacity", chunkAmount);
			log("log", "Résultat de l’achat de capacité d’énergie", {
				chunkAmount,
				ok: result && result.ok,
				status: result && result.status,
				text: result && result.text,
			});

			if (result && result.status === 402) {
				if (chunkAmount > 1) {
					chunkSize = Math.max(1, Math.floor(chunkAmount / 2));
					continue;
				}
				setStatus("waiting", "Solde de pixels insuffisant pour augmenter la capacité d’énergie.");
				return bought > 0 ? true : "insufficient";
			}
			if (!result || !result.ok) {
				log("warn", "Échec de l’achat de capacité d’énergie", result && result.status, result && result.text);
				const detail = result?.status ? " (HTTP " + result.status + ")" : "";
				setStatus("error", "Échec de l’achat de capacité d’énergie" + detail + ".");
				return bought > 0 ? true : false;
			}

			bought += chunkAmount;
			remaining -= chunkAmount;
			latestEnergy = (await fetchEnergySnapshot()).energy;
			chunkSize = Math.min(remaining, ENERGY_CAPACITY_PURCHASE_CHUNK);
			if (remaining > 0) await delay(COLOR_PURCHASE_PAUSE_MS);
		}

		if (!state.running) state.energy = latestEnergy;
		setStatus("done", "Capacité d’énergie augmentée de " + (bought * 5) + " unités.");
		updateEnergyDisplay();
		return true;
	}

	async function buyAllAffordableEnergyCapacity() {
		const availablePixels = await fetchAvailablePixels();
		const amount = Math.floor(availablePixels / 50);
		log("log", "Calcul de la capacité d’énergie disponible à l’achat", { availablePixels, amount });
		if (amount < 1) {
			setStatus("waiting", "Solde de pixels insuffisant pour augmenter la capacité d’énergie.");
			return false;
		}

		setStatus("buying", "Dépense de " + (amount * 50) + "/" + availablePixels + " pixels pour augmenter la capacité d’énergie…");
		return buyEnergyCapacity(amount);
	}

	async function buyMissingGhostColors() {
		if (state.running) {
			throw new Error("Arrêtez la peinture avant d’acheter des couleurs.");
		}

		const areaScope = describeAreaPurchaseScope();
		setStatus("syncing", "Recherche des couleurs manquantes " + areaScope + "...");
		const missing = await getMissingRequiredColors();
		if (!missing.length) {
			setStatus("idle", "Vous avez déjà toutes les couleurs nécessaires pour les pixels restants " + areaScope + ".");
			return { bought: 0, total: 0, insufficient: false };
		}
		const purchaseBatch = missing.slice(0, MAX_COLOR_PURCHASES_PER_RUN);
		const deferred = missing.length - purchaseBatch.length;

		const ok = confirm(
			"Acheter " + purchaseBatch.length +
			" couleur(s) nécessaire(s) pour les pixels restants " +
			areaScope + "?" +
			(deferred > 0
				? "\n\nLa limite par achat est de " + MAX_COLOR_PURCHASES_PER_RUN +
					" couleurs. Les " + deferred + " couleur(s) restante(s) pourront être achetées ensuite."
				: "")
		);
		if (!ok) {
			setStatus("idle", "Achat annulé.");
			return { bought: 0, total: purchaseBatch.length, remaining: missing.length, cancelled: true };
		}

		let bought = 0;
		for (const colorId of purchaseBatch) {
			const result = await buyColor(colorId);
			if (result === "insufficient") {
				setStatus("waiting", "Solde de pixels insuffisant. Couleurs achetées : " + bought + "/" + purchaseBatch.length + ".");
				invalidateTargets();
				return { bought, total: purchaseBatch.length, remaining: missing.length - bought, insufficient: true };
			}
			if (result !== true) {
				const remaining = missing.length - bought;
				setStatus("error", "Achat interrompu après un échec. Couleurs restantes : " + remaining + ".");
				invalidateTargets();
				return { bought, total: purchaseBatch.length, remaining, failed: true, insufficient: false };
			}
			bought++;
			await delay(COLOR_PURCHASE_PAUSE_MS);
		}

		invalidateTargets();
		const remaining = missing.length - bought;
		setStatus(
			"idle",
			bought + "/" + purchaseBatch.length + " couleur(s) achetée(s)." +
			(remaining > 0 ? " Couleurs restantes : " + remaining + "." : "")
		);
		return { bought, total: purchaseBatch.length, remaining, insufficient: false };
	}

	function loadImage(src) {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.decoding = "async";
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error("Impossible de lire l’image de la tuile."));
			img.src = src;
		});
	}

	async function webpToImageData(base64) {
		const img = await loadImage("data:image/webp;base64," + base64);
		if (img.naturalWidth !== TILE_SIZE || img.naturalHeight !== TILE_SIZE) {
			throw new Error("Dimensions de tuile GeoPixels invalides.");
		}
		const canvas = document.createElement("canvas");
		canvas.width = TILE_SIZE;
		canvas.height = TILE_SIZE;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		ctx.translate(0, TILE_SIZE);
		ctx.scale(1, -1);
		ctx.drawImage(img, 0, 0);
		return ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
	}

	function recordObservation(model, tile, index, color, onChange) {
		const previous = model.observed[index];
		if (previous === color) return;
		if (onChange && previous !== UNKNOWN_COLOR) onChange(index, previous, color);
		model.observed[index] = color;
		tile.unknown += (color === UNKNOWN_COLOR ? 1 : 0) - (previous === UNKNOWN_COLOR ? 1 : 0);
		const expected = model.colors[index];
		const oldStatus = pixelStatus(expected, previous);
		const newStatus = pixelStatus(expected, color);
		if (oldStatus === newStatus) return;
		if (targetCache?.model === model && targetCache.ranks[index]) {
			const rank = targetCache.ranks[index] - 1;
			countPixel(targetCache, rank, expected, oldStatus, -1);
			countPixel(targetCache, rank, expected, newStatus, 1);
		}
		if (purchaseTargetCache?.model === model && purchaseTargetCache.ranks[index]) {
			const rank = purchaseTargetCache.ranks[index] - 1;
			countPixel(purchaseTargetCache, rank, expected, oldStatus, -1);
			countPixel(purchaseTargetCache, rank, expected, newStatus, 1);
		}
	}

	async function readFullTilePixels(model, tile, imageData, onChange) {
		const { data } = imageData;
		if (data.length !== TILE_SIZE * TILE_SIZE * 4) throw new Error("Dimensions de tuile GeoPixels invalides.");
		const { left, right, top, bottom } = tile;
		let budget = WORK_CHUNK;
		for (let row = top; row < bottom; row++) {
			let index = row * model.width + left;
			let offset = ((tile.y + TILE_SIZE - 1 - model.gridY + row) * TILE_SIZE +
				model.gridX + left - tile.x) * 4;
			for (let col = left; col < right; col++, index++, offset += 4) {
				recordObservation(model, tile, index, data[offset + 3] === 0 ? -1 :
					(data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2], onChange);
			}
			budget -= right - left;
			if (budget <= 0) {
				budget = WORK_CHUNK;
				await yieldWork();
			}
		}
	}

	async function fetchTiles(tiles) {
		const response = await fetch("/GetPixelsCached", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			signal: AbortSignal.timeout(PAINT_REQUEST_TIMEOUT_MS),
			body: JSON.stringify({
				Tiles: tiles.map(({ x, y, timestamp, unknown }) => ({ x, y, timestamp: unknown ? 0 : timestamp })),
			}),
		});
		if (!response.ok) {
			const error = new Error("Échec du chargement des tuiles (HTTP " + response.status + ").");
			if (response.status === 429) error.retryDelay = rateLimitDelay(response.headers.get("Retry-After"));
			throw error;
		}
		return response.json();
	}

	async function syncBoard(options = {}, cache) {
		cache ??= await buildTargets(options);
		const { model, tiles } = cache;
		const { onChange } = options;
		if (tiles.length && !options.silent) setStatus("syncing", "Synchronisation de " + tiles.length + " tuile(s)…");
		for (const group of chunk(tiles, TILE_BATCH_SIZE)) {
			if (state.stopRequested) return cache;
			const payload = await fetchTiles(group);
			const timestamp = Number(payload?.ServerTimestamp);
			const requested = new Set(group);
			for (const [responseKey, response] of Object.entries(payload?.Tiles || {})) {
				const { x, y } = parseTileKey(responseKey);
				const tile = model.tilesByKey.get(tileKey(x, y));
				if (!tile || !requested.has(tile) || x !== tile.x || y !== tile.y ||
					(Number.isFinite(timestamp) && timestamp < tile.timestamp)) continue;

				if (response?.Type === "delta" && Array.isArray(response.Pixels)) {
					for (let i = 0; i < response.Pixels.length; i++) {
						if (i && i % WORK_CHUNK === 0) await yieldWork();
						const pixel = response.Pixels[i];
						if (!Array.isArray(pixel)) continue;
						const [gridX, gridY, rawColor] = pixel;
						if (![gridX, gridY].every((coordinate) => typeof coordinate === "number" ||
							(typeof coordinate === "string" && /^-?\d+$/.test(coordinate)))) continue;
						const col = Number(gridX) - model.gridX;
						const row = model.gridY - Number(gridY);
						if (!Number.isInteger(col) || !Number.isInteger(row) || col < tile.left || col >= tile.right ||
							row < tile.top || row >= tile.bottom) continue;
						if (typeof rawColor === "number" && !Number.isInteger(rawColor)) continue;
						const color = toColorId(rawColor);
						if (color === null || color < -1 || color > 0xFFFFFF) continue;
						recordObservation(model, tile, row * model.width + col, color, onChange);
					}
				} else if (response?.Type === "full" && response.ColorWebP) {
					await readFullTilePixels(model, tile, await webpToImageData(response.ColorWebP), onChange);
				} else {
					continue;
				}
				if (Number.isFinite(timestamp) && timestamp > 0) tile.timestamp = timestamp;
			}
		}
		if (!options.silent) updateProgress();
		return cache;
	}

	function selectNextTargets(cache, size) {
		const batch = [];
		const { model, indices } = cache;
		const sent = model.runNumber === state.runNumber ? model.sent : null;
		const select = (mask, first, excluded) => {
			while (cache[first] < mask.length && !mask[cache[first]]) cache[first]++;
			for (let word = cache[first]; word < mask.length && batch.length < size; word++) {
				let bits = excluded ? mask[word] & ~excluded[word] : mask[word];
				while (bits && batch.length < size) {
					const rank = word * 32 + 31 - Math.clz32(bits & -bits);
					bits &= bits - 1;
					const index = indices[rank];
					if (sent?.[index]) continue;
					batch.push({
						index,
						x: model.gridX + index % model.width,
						y: model.gridY - Math.floor(index / model.width),
						colorId: model.colors[index],
					});
				}
			}
		};
		if (settings.prioritizeIncorrectColors) select(cache.wrong, "firstWrong");
		select(cache.pending, "firstPending", settings.prioritizeIncorrectColors ? cache.wrong : null);
		return batch;
	}

	function recordPixelBatch(cache, batch, confirmed) {
		const { model } = cache;
		if (confirmed && model.runNumber !== state.runNumber) {
			model.runNumber = state.runNumber;
			model.sent = new Uint8Array(model.colors.length);
		}
		for (const target of batch) {
			const tile = modelTile(model, target.x - model.gridX, model.gridY - target.y);
			if (confirmed) model.sent[target.index] = 1;
			else tile.timestamp = 0; // Une réponse indéterminée exige une nouvelle lecture de la tuile.
			recordObservation(model, tile, target.index, confirmed ? target.colorId : UNKNOWN_COLOR);
		}
	}


	function readEnergy() {
		return state.energy ?? { current: null, capacity: null };
	}

	async function refreshAccount() {
		const auth = getAuthPayload();
		const previous = state.energy;
		const { energy } = await fetchEnergySnapshot(true);
		if (state.energy === previous && energy && getAuthPayload().userId === auth.userId) {
			state.energy = energy;
			updateEnergyDisplay();
		}
	}

	function getEnergyThreshold(capacity) {
		const starting = state.salvoPhase === "start";
		const unit = starting ? settings.startEnergyUnit : settings.resumeEnergyUnit;
		const configured = starting ? settings.startEnergyThreshold : settings.resumeEnergyThreshold;
		if (unit === "percent" && capacity === null) return null;
		const threshold = unit === "percent" ? Math.ceil(capacity * configured / 100) : configured;
		return Math.max(threshold, settings.energyReserve + 1);
	}

	function energyPollDelay(energy, threshold) {
		const missing = Math.max(1, threshold - (energy?.current ?? 0));
		const rate = energy?.rate;
		const delayMs = rate > 0 ? missing * rate * 1000 : ENERGY_POLL_MAX_MS;
		return Math.min(ENERGY_POLL_MAX_MS, Math.max(EMPTY_ENERGY_PAUSE_MIN_MS, delayMs));
	}

	function rateLimitDelay(retryAfter) {
		const waitMs = /^\d+$/.test(retryAfter)
			? Number(retryAfter) * 1000
			: Date.parse(retryAfter) - Date.now();
		return waitMs > 0 ? Math.max(REQUEST_PAUSE_MS, waitMs) : EMPTY_ENERGY_PAUSE_MIN_MS;
	}

	function formatDuration(seconds) {
		seconds = Math.max(0, Math.round(seconds));
		const days = Math.floor(seconds / 86400);
		const h = Math.floor((seconds % 86400) / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = seconds % 60;
		if (days > 0) return numberFormat.format(days) + " j " + h + " h";
		if (h > 0) return h + " h " + m + " min";
		if (m > 0) return m + " min " + s + " s";
		return s + " s";
	}

	function observedPaintRate() {
		const elapsed = (Date.now() - state.runStartedAt) / 1000;
		return state.running && !state.monitoring && state.paintedGroups >= 2 && elapsed >= 2 ? state.placedThisRun / elapsed : 0;
	}

	async function sendPixelBatch(targets, cache) {
		const pixels = targets
			.map((target) => ({
				GridX: Number(target.x),
				GridY: Number(target.y),
				Color: Number(target.colorId),
			}))
			.filter((pixel) =>
				Number.isFinite(pixel.GridX) &&
				Number.isFinite(pixel.GridY) &&
				Number.isFinite(pixel.Color)
			);

		if (!pixels.length) {
			return { ok: false, status: 0, text: "Aucun pixel valide à envoyer." };
		}

		installPageBridge();
		if (state.stopRequested || targetCache !== cache || !sameGhost(cache.model, getGhostSource())) return null;
		if (typeof win.__gpcPlacePixels === "function") {
			try {
				const result = normalizeEndpointResult(await win.__gpcPlacePixels(pixels));
				if (!result) return { ok: false, status: 0, requestUncertain: true };
				if (!result.needsSession) return result;
			} catch (error) {
				return { ok: false, status: 0, requestUncertain: true, text: String(error) };
			}
		}

		const auth = await withTimeout(getAuthPayloadAsync(), PAINT_REQUEST_TIMEOUT_MS, "Délai de connexion à GeoPixels dépassé.");
		if (state.stopRequested || targetCache !== cache || !sameGhost(cache.model, getGhostSource())) return null;
		if (!auth.token || !auth.subject || !Number.isFinite(auth.userId)) {
			return { ok: false, status: 401, text: "Session GeoPixels incomplète. Reconnectez-vous." };
		}

		const pixelsWithUserId = pixels.map((pixel) => ({
			...pixel,
			UserId: auth.userId,
		}));
		const payload = {
			Token: String(auth.token),
			Subject: String(auth.subject),
			UserId: auth.userId,
			Pixels: pixelsWithUserId,
		};

		try {
			const response = await fetch("/PlacePixels", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(PAINT_REQUEST_TIMEOUT_MS),
			});
			return {
				ok: response.ok,
				status: response.status,
				retryAfter: response.headers.get("Retry-After"),
				text: await response.text().catch(() => ""),
			};
		} catch (error) {
			return { ok: false, status: 0, requestUncertain: true, text: String(error) };
		}
	}

	function wait(ms) {
		if (state.stopRequested) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				stopWake = null;
				resolve();
			}, ms);
			stopWake = () => {
				clearTimeout(timer);
				stopWake = null;
				resolve();
			};
		});
	}

	function requestStop() {
		if (!state.running) return;
		state.stopRequested = true;
		if (stopWake) stopWake();
	}

	async function startBot() {
		if (targetPreview) await targetPreview;
		if (state.running || state.syncing) return;
		return settings.workMode === "maintenance" ? startMaintenance() : startConstruction();
	}

	async function startConstruction() {
		prepareCompletionNotifications();
		completionNotificationSent = false;
		hadPendingTargets = false;
		state.running = true;
		state.stopRequested = false;
		state.placedThisRun = 0;
		state.paintedGroups = 0;
		state.runStartedAt = Date.now();
		state.runNumber++;
		state.salvoPhase = "start";
		state.nextBatchSize = 0;
		state.rechargePending = false;
		const salvos = settings.energyMode === "salvos";
		const limit = settings.maxBatchSize || MAX_PIXELS_PER_REQUEST;
		let salvoRemaining = 0;
		let refreshBoardBeforeSend = false;
		let completed = false;
		const automaticColors = settings.automaticPurchases.accountId !== null &&
			settings.automaticPurchases.policy !== "off" &&
			settings.automaticPurchases.enabled.includes("ExtraColor");
		setButtons();

		try {
			setStatus("running", "Préparation de l’image…");
			if (!getOwnedColorIds()) {
				const reading = await fetchEnergySnapshot();
				if (reading.energy) state.energy = reading.energy;
			}
			if (state.stopRequested) throw new Error("Arrêté");
			let syncedCache = await syncBoard();
			let lastSyncAt = Date.now();

			while (!state.stopRequested) {
				const cache = await buildTargets();
				if (cache !== syncedCache || Date.now() - lastSyncAt >= BOARD_REFRESH_MS) {
					syncedCache = await syncBoard({}, cache);
					lastSyncAt = Date.now();
					refreshBoardBeforeSend = false;
				}
				if (state.stopRequested) break;
				updateProgress();
				if (state.remaining > 0) hadPendingTargets = true;

				const automatic = await runAutomaticPurchases(cache.counts[PIXEL_WRONG] + cache.counts[PIXEL_EMPTY] > 0);
				if (state.stopRequested) break;
				if (automatic?.colorsChanged) {
					await wait(COLOR_PURCHASE_PAUSE_MS);
					if (state.stopRequested) break;
					invalidateTargets();
					continue;
				}
				if (targetCache !== cache || !sameGhost(cache.model, getGhostSource())) continue;
				if (automatic) updateProgress();
				if (!state.remaining) {
					if (automatic?.colorsOutstanding) {
						setStatus("waiting", "En attente du déblocage des couleurs du dessin.");
						await wait(EMPTY_ENERGY_PAUSE_MIN_MS);
						continue;
					}
					setStatus("done", automaticColors ? "Aucun pixel accessible à peindre dans la sélection."
						: "Tous les pixels sélectionnés sont déjà corrects.");
					completed = true;
					notifyCompletion();
					break;
				}
				if (!cache.counts[PIXEL_WRONG] && !cache.counts[PIXEL_EMPTY]) {
					setStatus("waiting", "Des pixels restent non observés. Relancez la synchronisation pour les vérifier.");
					break;
				}

				const reading = automatic?.reading ?? await fetchEnergySnapshot();
				if (state.stopRequested) break;
				state.nextBatchSize = 0;
				state.rechargePending = false;
				if (reading.status === 401 || reading.status === 403) {
					setStatus("error", "Lecture de l’énergie refusée. Vérifiez votre session GeoPixels.");
					break;
				}
				if (!reading.energy) {
					const limited = reading.status === 429;
					const delayMs = limited ? rateLimitDelay(reading.retryAfter) : energyPollDelay(state.energy, 0);
					if (delayMs > 2147483647) {
						setStatus("error", "GeoPixels impose un délai de reprise trop long. Réessayez plus tard.");
						break;
					}
					setStatus("waiting", limited
						? "Limite de requêtes atteinte pour la lecture de l’énergie."
						: "Énergie indisponible. Nouvelle lecture en attente…");
					updateEnergyDisplay();
					refreshBoardBeforeSend = true;
					await wait(delayMs);
					continue;
				}

				const energy = reading.energy;
				state.energy = energy;
				const available = Math.max(0, energy.current - settings.energyReserve);
				if (salvos && state.salvoPhase === "active" && (!available || !salvoRemaining)) {
					state.salvoPhase = "resume";
				}
				const waitingForSalvo = salvos && state.salvoPhase !== "active";
				const threshold = waitingForSalvo ? getEnergyThreshold(energy.capacity) : settings.energyReserve + 1;
				if (threshold === null || energy.current < threshold) {
					const exceedsCapacity = energy.capacity !== null && threshold > energy.capacity;
					state.rechargePending = threshold !== null && !exceedsCapacity;
					setStatus("waiting", threshold === null
						? "Capacité maximale indisponible. Nouvelle lecture en attente…"
						: exceedsCapacity
							? "Seuil attendu supérieur à la capacité. Vérifiez le seuil et la réserve."
							: "Le prochain groupe attend la recharge de l’énergie.");
					updateEnergyDisplay();
					refreshBoardBeforeSend = true;
					const energyDelay = energyPollDelay(energy, threshold ?? 0);
					const rechargeDelay = automatic?.purchased ? COLOR_PURCHASE_PAUSE_MS
						: automatic ? Math.min(energyDelay, EMPTY_ENERGY_PAUSE_MIN_MS) : energyDelay;
					await wait(rechargeDelay);
					continue;
				}
				if (refreshBoardBeforeSend) {
					refreshBoardBeforeSend = false;
					syncedCache = await syncBoard({}, cache);
					lastSyncAt = Date.now();
					continue;
				}
				if (waitingForSalvo) {
					state.salvoPhase = "active";
					salvoRemaining = available;
				}
				const batch = selectNextTargets(cache, Math.min(available, salvos ? salvoRemaining : available, limit));
				const amount = batch.length;
				if (!amount) {
					setStatus("waiting", "Des pixels déjà envoyés ont changé. Redémarrez pour les corriger.");
					break;
				}
				state.nextBatchSize = amount;
				updateEnergyDisplay();
				setStatus("running", "Envoi de " + amount + " pixel(s)…");

				const result = await sendPixelBatch(batch, cache);
				if (!result) continue;
				state.nextBatchSize = 0;
				if (!result.ok || result.text !== "Ok") {
					log("warn", "Échec de l’envoi des pixels", result.status, result.text);
					if (result.status === 403 && /not enough energy/i.test(result.text || "")) {
						state.energy = { ...energy, current: null };
						state.rechargePending = true;
						if (salvos) state.salvoPhase = "resume";
						salvoRemaining = 0;
						setStatus("waiting", "Énergie insuffisante. Le prochain groupe attend la recharge.");
						updateEnergyDisplay();
						refreshBoardBeforeSend = true;
						const resumeThreshold = salvos ? getEnergyThreshold(energy.capacity) : settings.energyReserve + 1;
						await wait(energyPollDelay(energy, resumeThreshold ?? 0));
						continue;
					}
					if (result.status === 429) {
						const delayMs = rateLimitDelay(result.retryAfter);
						if (delayMs <= 2147483647) {
							setStatus("waiting", "Limite de requêtes atteinte. Reprise après le délai indiqué par GeoPixels.");
							updateEnergyDisplay();
							refreshBoardBeforeSend = true;
							await wait(delayMs);
							continue;
						}
					}
					const uncertain = result.ok || result.requestUncertain || result.status === 0 || result.status === 408 || result.status >= 500;
					if (uncertain) recordPixelBatch(cache, batch, false);
					setStatus("error", uncertain
						? "Résultat de l’envoi incertain. La peinture est arrêtée. Redémarrez pour resynchroniser la carte."
						: result.status === 413
							? "Groupe refusé par GeoPixels. Réduisez la taille maximale des groupes."
							: "Échec de l’envoi des pixels (HTTP " + result.status + ").");
					break;
				}

				recordPixelBatch(cache, batch, true);
				state.placedThisRun += amount;
				state.paintedGroups++;
				state.energy = { ...energy, current: energy.current - amount };
				if (salvos) {
					salvoRemaining -= amount;
					if (!salvoRemaining || amount === available) state.salvoPhase = "resume";
				}
				if (!salvos || state.salvoPhase === "active") {
					const usable = available - amount;
					const pending = cache.counts[PIXEL_WRONG] + cache.counts[PIXEL_EMPTY];
					state.nextBatchSize = Math.min(usable, salvos ? salvoRemaining : usable, pending, limit);
				}
				updateProgress();

				if (targetCache !== cache || !sameGhost(cache.model, getGhostSource())) {
					await wait(REQUEST_PAUSE_MS);
					continue;
				}
				if (state.remaining === 0 && !automaticColors) {
					setStatus("done", "Tous les pixels sélectionnés ont été envoyés.");
					completed = true;
					notifyCompletion();
					break;
				}

				await wait(REQUEST_PAUSE_MS);
			}

			if (state.stopRequested && state.status !== "error") setStatus("stopped", "Arrêté");
		} catch (error) {
			if (state.stopRequested) setStatus("stopped", "Arrêté");
			else {
				log("error", error);
				setStatus("error", error instanceof TypeError
					? "La peinture a été interrompue. Vérifiez votre connexion à GeoPixels."
					: error?.message || "La peinture a été interrompue.");
			}
		} finally {
			if (state.stopRequested) completed = false;
			state.running = false;
			state.stopRequested = false;
			state.salvoPhase = "start";
			state.nextBatchSize = 0;
			state.rechargePending = false;
			setButtons();
			updateProgress();
		}
		if (completed && settings.autoMaintenance) return startMaintenance(true);
	}

	function trackMaintenanceChanges(cache) {
		const report = { changedCount: 0, samples: [] };
		let seen;
		const { model, ranks } = cache;
		const observe = (index, previous, current) => {
			if (!ranks[index]) return;
			const rank = ranks[index] - 1;
			seen ??= new Uint8Array(Math.ceil(cache.indices.length / 8));
			const byte = rank >>> 3;
			const bit = 1 << (rank & 7);
			if (seen[byte] & bit) {
				const sample = report.samples.find((item) => item.index === index);
				if (sample) sample.current = current;
				return;
			}
			seen[byte] |= bit;
			report.changedCount++;
			if (report.samples.length < MAINTENANCE_SAMPLE_SIZE) {
				report.samples.push({
					index, previous, current,
					x: model.gridX + index % model.width,
					y: model.gridY - Math.floor(index / model.width),
				});
			}
		};
		return { report, observe };
	}

	async function startMaintenance(afterConstruction = false) {
		state.running = true;
		state.monitoring = true;
		state.stopRequested = false;
		state.maintenanceCheck = null;
		let previousCache = null;
		let changes = null;
		setButtons();
		updateProgress();
		try {
			while (!state.stopRequested) {
				let sleepMs = settings.maintenanceInterval * 1000;
				state.maintenanceStatus = "Vérification…";
				renderMaintenance();
				try {
					const cache = await buildTargets({ monitor: true });
					if (cache !== previousCache) changes = null;
					await syncBoard({ silent: true, onChange: changes?.observe }, cache);
					if (state.stopRequested) break;
					if (targetCache !== cache || !sameGhost(cache.model, getGhostSource())) continue;

					const unknown = cache.counts[PIXEL_UNKNOWN];
					if (afterConstruction) {
						if (!cache.indices.length || cache.counts[PIXEL_CORRECT] !== cache.indices.length) {
							setStatus("waiting", "Surveillance automatique reportée. Le modèle sélectionné reste incomplet ou partiellement observé.");
							break;
						}
						settings.workMode = "maintenance";
						saveSettings();
						if (ui.workMode) ui.workMode.value = settings.workMode;
						afterConstruction = false;
					}

					const report = changes?.report ?? { changedCount: 0, samples: [] };
					state.maintenanceCheck = { ...report, at: Date.now() };
					previousCache = cache;
					changes = trackMaintenanceChanges(cache);
					if (!cache.indices.length) {
						state.maintenanceStatus = "En attente d’une sélection";
						setStatus("waiting", "Aucun pixel sélectionné à surveiller.");
					} else {
						state.maintenanceStatus = unknown ? "Partielle" : "Active";
						setStatus("watching", report.changedCount ? "Des modifications ont été détectées sur le modèle."
							: unknown ? "Certains pixels du modèle sont encore non observés." : "Surveillance en cours.");
					}
					updateProgress();
				} catch (error) {
					if (state.stopRequested) break;
					log("warn", "Vérification de maintenance interrompue.", error);
					const retryDelay = error?.retryDelay ?? 0;
					state.maintenanceStatus = "Vérification interrompue";
					setStatus("waiting", error?.message || "Impossible de vérifier le modèle.");
					if (afterConstruction || retryDelay > 2147483647) return;
					sleepMs = Math.max(sleepMs, retryDelay);
					renderMaintenance();
				}
				await wait(sleepMs);
			}
		} finally {
			const stopped = state.stopRequested;
			state.running = false;
			state.monitoring = false;
			state.stopRequested = false;
			if (stopped) setStatus("stopped", "Surveillance arrêtée.");
			state.maintenanceStatus = stopped ? "Arrêtée" :
				state.maintenanceStatus === "Vérification interrompue" ? state.maintenanceStatus : "Inactive";
			setButtons();
			updateProgress();
		}
	}

	async function manualSync() {
		if (targetPreview) await targetPreview;
		if (state.running || state.syncing) return;
		state.syncing = true;
		setButtons();
		try {
			const reading = await fetchEnergySnapshot();
			if (reading.energy) state.energy = reading.energy;
			await syncBoard({ monitor: settings.workMode === "maintenance" });
			const balance = automaticBalance(reading.data);
			autoPurchases.balance = balance === null ? null : Math.floor(balance / 5);
			renderAutomaticPurchases();
			setStatus("idle", "Synchronisation terminée");
			updateProgress();
		} catch (error) {
			log("error", error);
			setStatus("error", error instanceof TypeError
				? "Impossible de synchroniser l’image. Vérifiez votre connexion à GeoPixels."
				: error?.message || "Impossible de synchroniser l’image.");
		} finally {
			state.syncing = false;
			setButtons();
		}
	}

	function setStatus(status, message) {
		state.status = status;
		if (message) state.message = message;
		if (ui.status) {
			ui.status.textContent = STATUS_LABELS[status];
			ui.status.dataset.status = status;
		}
		if (ui.message) ui.message.textContent = state.message;
		if (ui.dot) ui.dot.dataset.status = status;
	}

	function setButtons() {
		if (!ui.start || !ui.stop || !ui.sync) return;
		ui.start.disabled = state.running || state.syncing;
		ui.stop.disabled = !state.running;
		ui.sync.disabled = state.running || state.syncing;
		if (ui.buyColors) ui.buyColors.disabled = state.running;
		if (ui.buyCapacity) ui.buyCapacity.disabled = state.running;
		if (ui.energyControls) ui.energyControls.disabled = state.running;
		if (ui.autoControls) ui.autoControls.disabled = state.running;
		if (ui.workMode) ui.workMode.disabled = state.running || state.syncing;
		if (ui.maintenanceControls) ui.maintenanceControls.disabled = state.running;
	}

	function updateEnergyDisplay() {
		if (!ui.energyText) return;
		const { current, capacity } = readEnergy();
		const salvos = settings.energyMode === "salvos";
		const threshold = salvos && state.salvoPhase !== "active" ? getEnergyThreshold(capacity) : null;
		ui.energyText.textContent = current !== null && capacity !== null
			? numberFormat.format(current) + " / " + numberFormat.format(capacity)
			: "Chargement…";
		ui.salvoState.textContent = salvos ? SALVO_LABELS[state.salvoPhase] : "Mode continu";
		ui.energyThreshold.textContent = threshold ?? "—";
		ui.nextBatchSize.textContent = state.rechargePending ? "En attente de recharge"
			: state.running && !state.monitoring ? state.nextBatchSize : "—";
	}

	function renderMaintenance() {
		if (!ui.maintenanceStatus) return;
		const check = state.maintenanceCheck;
		ui.maintenanceStatus.textContent = state.maintenanceStatus;
		ui.maintenanceChanged.textContent = check ? numberFormat.format(check.changedCount) : "—";
		ui.maintenanceTime.textContent = check ? checkTimeFormat.format(check.at) : "—";
		ui.maintenanceTime.dateTime = check ? new Date(check.at).toISOString() : "";
		ui.maintenanceSamples.textContent = (check?.samples ?? []).map(({ x, y, previous, current }) =>
			x + ", " + y + " · " + (previous === -1 ? "vide" : colorHex(previous)) + " → " +
			(current === -1 ? "vide" : colorHex(current))
		).join("\n");
	}

	function bindEnergySettings() {
		const controls = {
			energyMode: ui.energyControls.querySelector("#gpc-energy-mode"),
			startEnergyUnit: ui.energyControls.querySelector("#gpc-energy-start-unit"),
			startEnergyThreshold: ui.energyControls.querySelector("#gpc-energy-start-value"),
			resumeEnergyUnit: ui.energyControls.querySelector("#gpc-energy-resume-unit"),
			resumeEnergyThreshold: ui.energyControls.querySelector("#gpc-energy-resume-value"),
			energyReserve: ui.energyControls.querySelector("#gpc-energy-reserve"),
			maxBatchSize: ui.energyControls.querySelector("#gpc-energy-group-limit"),
		};
		const syncControls = () => {
			for (const [name, control] of Object.entries(controls)) control.value = settings[name];
			const continuous = settings.energyMode === "continuous";
			for (const phase of ["start", "resume"]) {
				const unit = controls[phase + "EnergyUnit"];
				const threshold = controls[phase + "EnergyThreshold"];
				unit.disabled = continuous;
				threshold.disabled = continuous;
				threshold.max = unit.value === "percent" ? "100" : "";
			}
		};
		for (const [name, control] of Object.entries(controls)) {
			control.addEventListener("change", () => {
				if (state.running) return;
				Object.assign(settings, normalizeEnergySettings({ ...settings, [name]: control.value }));
				saveSettings();
				syncControls();
				updateEnergyDisplay();
				updateProgress();
			});
		}
		syncControls();
	}

	function renderAutomaticPurchases() {
		if (!ui.autoControls) return;
		const config = settings.automaticPurchases;
		ui.autoBalance.textContent = autoPurchases.balance === null ? "—" : autoPurchases.balance + " Pixels";
		ui.autoSpent.textContent = autoPurchases.spent + " Pixels";
		ui.autoActive.textContent = config.order.filter((type) => config.enabled.includes(type))
			.map((type) => AUTO_UPGRADES[type].label).join(" → ") || "Aucune";
		ui.autoNext.textContent = autoPurchases.next || "—";
		ui.autoMessage.textContent = autoPurchases.message || (config.policy === "off" ? "Achats désactivés."
			: config.accountId === null ? "Autorisation requise." : "Achats autorisés pendant la peinture.");
	}

	function bindAutomaticPurchases() {
		const policy = ui.autoControls.querySelector("#gpc-auto-policy");
		const reserve = ui.autoControls.querySelector("#gpc-auto-reserve");
		const limit = ui.autoControls.querySelector("#gpc-auto-limit");
		const authorize = ui.autoControls.querySelector("#gpc-auto-authorize");
		const rows = AUTO_UPGRADE_ORDER.map((type) => ({
			type,
			row: ui.autoControls.querySelector("#gpc-auto-row-" + type),
			enabled: ui.autoControls.querySelector("#gpc-auto-enabled-" + type),
			higher: ui.autoControls.querySelector("#gpc-auto-higher-" + type),
		}));

		const refreshControls = () => {
			const config = settings.automaticPurchases;
			policy.value = config.policy;
			reserve.value = config.reserve;
			limit.value = config.limit;
			limit.disabled = config.policy !== "limited";
			for (const { type, row, enabled, higher } of rows) {
				const rank = config.order.indexOf(type);
				row.style.order = rank;
				enabled.checked = config.enabled.includes(type);
				higher.disabled = rank === 0;
			}
			authorize.disabled = config.policy === "off" || !config.enabled.length;
			authorize.textContent = config.accountId === null ? "Autoriser les achats" : "Retirer l’autorisation";
			renderAutomaticPurchases();
		};
		const configure = (changes) => {
			settings.automaticPurchases = normalizeAutomaticPurchases({
				...settings.automaticPurchases, ...changes, accountId: null,
			});
			saveSettings();
			autoPurchases.retryAt = 0;
			updateAutomaticPurchases("");
			refreshControls();
		};
		policy.addEventListener("change", () => configure({ policy: policy.value }));
		reserve.addEventListener("change", () => configure({ reserve: reserve.value }));
		limit.addEventListener("change", () => configure({ limit: limit.value }));
		for (const { type, enabled, higher } of rows) {
			enabled.addEventListener("change", () => {
				const list = new Set(settings.automaticPurchases.enabled);
				if (enabled.checked) list.add(type);
				else list.delete(type);
				configure({ enabled: [...list] });
			});
			higher.addEventListener("click", () => {
				const order = [...settings.automaticPurchases.order];
				const index = order.indexOf(type);
				if (index === 0) return;
				[order[index - 1], order[index]] = [order[index], order[index - 1]];
				configure({ order });
			});
		}
		authorize.addEventListener("click", () => {
			const config = settings.automaticPurchases;
			if (config.accountId !== null) {
				configure({});
				return;
			}
			const auth = getAuthPayload();
			if (!auth.token || !Number.isSafeInteger(auth.userId) || auth.userId <= 0) {
				updateAutomaticPurchases("Connectez-vous à GeoPixels pour autoriser les achats.");
				return;
			}
			if (config.policy === "off" || !config.enabled.length) return;
			const budget = config.policy === "limited" ? config.limit + " Pixels au total" : "illimité";
			if (!win.confirm("Autoriser les achats automatiques en Pixels pour le compte GeoPixels " + auth.userId +
				" pendant la peinture ? Budget " + budget + ", réserve de " + config.reserve + " Pixels.")) return;
			config.accountId = auth.userId;
			saveSettings();
			updateAutomaticPurchases("Achats autorisés pendant la peinture.");
			refreshControls();
		});

		const accountId = getAuthPayload().userId;
		if (Number.isSafeInteger(accountId) && accountId > 0) {
			try { autoPurchases.spent = readAutomaticPurchaseLedger(accountId).spent; } catch {}
		}
		refreshControls();
	}

	function updateProgress() {
		const total = targetCache?.indices.length ?? 0;
		const [unknown, done, wrong, empty] = targetCache?.counts ?? [0, 0, 0, 0];
		const remaining = total - done;
		const percent = total > 0 ? Math.floor((done / total) * 100) : 0;
		state.remaining = remaining;

		if (ui.bar) ui.bar.style.width = percent + "%";
		if (ui.progress) ui.progress.setAttribute("aria-valuenow", String(percent));
		if (ui.countText) ui.countText.textContent = numberFormat.format(done) + " / " + numberFormat.format(total);
		if (ui.remainingText) ui.remainingText.textContent = numberFormat.format(remaining);
		if (ui.wrongText) ui.wrongText.textContent = numberFormat.format(wrong);
		if (ui.unknownText) ui.unknownText.textContent = numberFormat.format(unknown);
		if (ui.emptyText) ui.emptyText.textContent = numberFormat.format(empty);
		updateEnergyDisplay();
		renderMaintenance();
		const rate = observedPaintRate();
		if (ui.etaText) ui.etaText.textContent = rate && remaining && !unknown ? formatDuration(remaining / rate) : "—";
		if (ui.rateText) ui.rateText.textContent = rate ? numberFormat.format(rate * 60) + " px/min" : "—";
		if (ui.paletteSection?.open && paletteView.renderedCache !== targetCache) renderPalette();
	}

	async function countModelColors(analysis) {
		const { colors } = await analysis.pixels;
		const counts = new Map();
		const ids = [];
		for (let start = 0; start < colors.length; start += WORK_CHUNK) {
			const end = Math.min(start + WORK_CHUNK, colors.length);
			for (let index = start; index < end; index++) {
				const id = colors[index];
				const count = counts.get(id);
				if (count === undefined) ids.push(id);
				counts.set(id, (count ?? 0) + 1);
			}
			if (end < colors.length) await delay(0);
		}
		return { counts, ids };
	}

	function queueTargetPreview() {
		const monitor = settings.workMode === "maintenance";
		if (targetPreview || state.running || state.syncing || !getGhostSource() || (!monitor && !getOwnedColorIds())) return;
		targetPreview = buildTargets({ monitor }).then(updateProgress).catch((error) => {
			log("warn", "Aperçu de la sélection indisponible.", error);
		}).finally(() => { targetPreview = null; });
	}

	function refreshPaletteModel() {
		const image = readGlobal("ghostImageOriginalData");
		const source = getGhostSource();
		const position = source ? source.gridX + "," + source.gridY : null;
		const auth = getAuthPayload();
		const accountId = auth.token ? auth.userId : null;
		if (accountId !== paletteView.accountId) {
			paletteView.accountId = accountId;
			clearPreviousPalette(accountId);
			renderPalette();
			if (accountId > 0 && paletteReading.accountId !== accountId && !getOwnedColorIds() &&
				!state.running && !state.syncing) void refreshAccount();
			queueTargetPreview();
		}
		recoverNativePalette(accountId);
		if (position !== paletteView.position) {
			paletteView.position = position;
			queueTargetPreview();
		}
		if (image === paletteView.image) return;
		paletteView.image = image;
		paletteView.histogram = null;
		paletteView.page = 0;
		const request = ++paletteView.request;
		renderPalette();
		if (!image?.data) return;
		const analysis = analyzeImage(image);
		analysis.histogram ??= countModelColors(analysis);
		analysis.histogram.then((histogram) => {
			if (request !== paletteView.request) return;
			paletteView.histogram = histogram;
			renderPalette();
			queueTargetPreview();
		}).catch((error) => {
			log("warn", "Analyse de la palette du modèle impossible.", error);
			if (request === paletteView.request && ui.paletteMessage) ui.paletteMessage.textContent = "Palette du modèle indisponible.";
		});
	}

	function renderPalette() {
		if (!ui.paletteSection?.open) return;
		paletteView.renderedCache = targetCache;
		const owned = getOwnedColorIds();
		const fromAccount = ui.paletteSource.value === "account";
		const histogram = paletteView.histogram;
		let ids = (fromAccount ? (owned ? [...owned] : []) : histogram?.ids) ?? [];
		const query = ui.paletteSearch.value.trim();
		if (query) {
			const match = query.match(/^#?([0-9a-f]{6}|00000000)$/i);
			const id = match ? toColorId("#" + match[1]) : null;
			const present = fromAccount ? owned?.has(id) : histogram?.counts.has(id);
			ids = present ? [id] : [];
		}
		const pages = Math.max(1, Math.ceil(ids.length / PALETTE_PAGE_SIZE));
		paletteView.page = Math.min(paletteView.page, pages - 1);
		const first = paletteView.page * PALETTE_PAGE_SIZE;
		const prioritized = new Set(settings.priorityColors);
		const excluded = new Set(settings.ignoredColors);
		const selected = targetCache && targetCache.model.imageData === paletteView.image ? targetCache.frequencies : null;
		const focus = document.activeElement?.dataset;
		const markup = ids.slice(first, first + PALETTE_PAGE_SIZE).map((id) => {
			const hex = colorHex(id);
			const availability = id === -1 ? "Effacement" : !owned ? "Disponibilité inconnue"
				: !owned.has(id) ? "Manquante" : !baseColors ? "Disponible · type inconnu"
				: baseColors.has(id) ? "Gratuite · palette de base" : "Débloquée";
			const count = histogram ? numberFormat.format(histogram.counts.get(id) ?? 0) : "—";
			const chosen = selected ? " · " + numberFormat.format(selected.get(id) ?? 0) + " retenus" : "";
			const tone = id !== -1 ? " style=\"--gpc-chip-color:" + hex + "\"" : "";
			return `<div class="gpc-palette-row">
				<span class="gpc-swatch"${tone} aria-hidden="true"></span>
				<div><strong>${hex}</strong> <small>${availability}</small><br><small>${count} px${chosen}</small></div>
				<div class="gpc-palette-actions">
					<button class="gpc-btn" type="button" data-color="${id}" data-color-action="priorityColors" aria-label="Priorité ${hex}" aria-pressed="${prioritized.has(id)}">Priorité</button>
					<button class="gpc-btn" type="button" data-color="${id}" data-color-action="ignoredColors" aria-label="Exclure ${hex}" aria-pressed="${excluded.has(id)}">Exclure</button>
				</div>
			</div>`;
		}).join("");
		if (ui.paletteList.innerHTML !== markup) {
			ui.paletteList.innerHTML = markup;
			if (/^-?\d+$/.test(focus?.color) && ["priorityColors", "ignoredColors"].includes(focus.colorAction)) {
				ui.paletteList.querySelector('[data-color="' + focus.color + '"][data-color-action="' + focus.colorAction + '"]')
					?.focus?.({ preventScroll: true });
			}
		}
		ui.palettePage.textContent = (paletteView.page + 1) + " / " + pages;
		ui.palettePrevious.disabled = paletteView.page === 0;
		ui.paletteNext.disabled = paletteView.page + 1 >= pages;
		ui.paletteMessage.textContent = fromAccount && !owned ? "Aucune liste de couleurs détenues à afficher."
			: !fromAccount && !paletteView.image ? "Chargez un modèle ou affichez la palette du compte."
			: !fromAccount && !histogram ? "Analyse des couleurs du modèle…"
			: !ids.length ? "Aucune couleur trouvée." : numberFormat.format(ids.length) + (ids.length === 1 ? " couleur" : " couleurs");
		ui.paletteTransparency.hidden = !fromAccount;
		renderPaletteReading(owned);
	}

	function paletteDebug(owned = getOwnedColorIds()) {
		const { status, source, format, native, httpStatus, reason } = paletteReading;
		return {
			status: status === "synced" && !owned ? "unavailable" : status,
			source, format, native, httpStatus, reason, ownedCount: owned?.size ?? null,
		};
	}

	function renderPaletteReading(owned) {
		const { status, source, format, native, httpStatus, reason, ownedCount } = paletteDebug(owned);
		const labels = {
			loading: "Palette du compte en cours de chargement…",
			synced: "Palette du compte synchronisée",
			unavailable: "Palette du compte indisponible",
			error: "Erreur de lecture de la palette du compte",
		};
		ui.paletteStatus.textContent = labels[status];
		ui.paletteDiagnostic.textContent = [
			httpStatus === null ? null : "HTTP " + httpStatus,
			format ? "Réponse : " + format : null,
			native ? "Colors : " + native : null,
			source ? "Source : " + source : null,
			ownedCount === null ? null : numberFormat.format(ownedCount) + " couleur(s) détenue(s)",
			status !== "synced" && owned ? "Dernière palette vérifiée conservée." : null,
			reason,
		].filter(Boolean).join(" · ");
	}

	function bindPalette(panel) {
		ui.paletteSection = panel.querySelector("#gpc-palette-section");
		ui.paletteSource = panel.querySelector("#gpc-palette-source");
		ui.paletteSearch = panel.querySelector("#gpc-palette-search");
		ui.paletteList = panel.querySelector("#gpc-palette-list");
		ui.paletteMessage = panel.querySelector("#gpc-palette-message");
		ui.paletteStatus = panel.querySelector("#gpc-palette-status");
		ui.paletteDiagnostic = panel.querySelector("#gpc-palette-diagnostic");
		ui.paletteTransparency = panel.querySelector("#gpc-palette-transparency");
		ui.palettePage = panel.querySelector("#gpc-palette-page");
		ui.palettePrevious = panel.querySelector("#gpc-palette-previous");
		ui.paletteNext = panel.querySelector("#gpc-palette-next");
		const exclusive = panel.querySelector("#gpc-priority-only");
		ui.paletteSource.value = "model";
		exclusive.checked = settings.onlyPriorityColors;
		exclusive.addEventListener("change", () => {
			settings.onlyPriorityColors = exclusive.checked;
			applyFiltersChanged();
		});
		for (const control of [ui.paletteSource, ui.paletteSearch]) {
			control.addEventListener(control === ui.paletteSearch ? "input" : "change", () => {
				paletteView.page = 0;
				renderPalette();
			});
		}
		ui.palettePrevious.addEventListener("click", () => {
			paletteView.page = Math.max(0, paletteView.page - 1);
			renderPalette();
		});
		ui.paletteNext.addEventListener("click", () => {
			paletteView.page++;
			renderPalette();
		});
		const refresh = panel.querySelector("#gpc-palette-refresh");
		refresh.addEventListener("click", async () => {
			refresh.disabled = true;
			try {
				await Promise.all([loadBasePalette(), refreshAccount()]);
				refreshPaletteModel();
				renderPalette();
				queueTargetPreview();
				if (targetPreview) await targetPreview;
			} finally {
				refresh.disabled = false;
			}
		});
		ui.paletteSection.addEventListener("toggle", () => {
			if (!ui.paletteSection.open) {
				if (paletteView.timer !== null) clearInterval(paletteView.timer);
				paletteView.timer = null;
				return;
			}
			refreshPaletteModel();
			renderPalette();
			if (paletteView.timer === null) paletteView.timer = setInterval(refreshPaletteModel, 1000);
		});
		ui.paletteList.addEventListener("click", (event) => {
			const rowButton = event.target.closest("button[data-color-action]");
			if (!rowButton) return;
			const { colorAction, color } = rowButton.dataset;
			if (!["priorityColors", "ignoredColors"].includes(colorAction)) return;
			const id = Number(color);
			if (!Number.isInteger(id) || id < -1 || id > 0xFFFFFF) return;
			const selection = new Set(settings[colorAction]);
			if (!selection.delete(id)) selection.add(id);
			settings[colorAction] = [...selection];
			applyFiltersChanged();
		});
		for (const [button, field] of [["#gpc-priority-clear", "priorityColors"], ["#gpc-ignore-clear", "ignoredColors"]]) {
			panel.querySelector(button).addEventListener("click", () => {
				settings[field] = [];
				applyFiltersChanged();
			});
		}
	}

	function areaFromInputs() {
		return normalizeArea({
			id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
			mode: ui.areaMode.value,
			x1: ui.areaX1.value,
			y1: ui.areaY1.value,
			x2: ui.areaX2.value,
			y2: ui.areaY2.value,
		});
	}

	function addArea(area) {
		const normalized = normalizeArea(area, settings.areas.length);
		if (!normalized) {
			setStatus("error", "Saisissez des coordonnées valides pour les deux coins.");
			return false;
		}
		settings.areas.push(normalized);
		applyFiltersChanged(true);
		setStatus(
			"idle",
			normalized.mode === "include"
				? "Zone de peinture ajoutée."
				: "Zone d’exclusion ajoutée."
		);
		return true;
	}

	function renderAreas() {
		if (!ui.areaList) return;
		ui.areaList.innerHTML = "";
		if (!settings.areas.length) {
			ui.areaList.textContent = "Aucune";
		} else {
			for (const area of settings.areas) {
				const item = document.createElement("div");
				item.className = "gpc-area-item";
				item.dataset.mode = area.mode;
				const title = document.createElement("strong");
				title.textContent = area.mode === "include" ? "Zone de peinture" : "Zone d’exclusion";
				const coordinates = document.createElement("span");
				coordinates.textContent = `(${area.x1}, ${area.y1}) à (${area.x2}, ${area.y2})`;
				coordinates.className = "gpc-muted";
				const remove = document.createElement("button");
				remove.type = "button";
				remove.className = "gpc-btn gpc-area-remove";
				remove.textContent = "Retirer";
				remove.addEventListener("click", () => {
					settings.areas = settings.areas.filter((candidate) => candidate.id !== area.id);
					applyFiltersChanged(true);
					setStatus("idle", "Zone retirée.");
				});
				item.append(title, coordinates, remove);
				ui.areaList.appendChild(item);
			}
		}
		try {
			installPageBridge();
			if (typeof win.__gpcRenderAreas === "function") {
				win.__gpcRenderAreas(settings.areas.map((area) => ({ ...area })));
			}
		} catch {}
	}

	function applyFiltersChanged(redrawAreas = false) {
		saveSettings();
		invalidateTargets();
		if (redrawAreas) renderAreas();
		updateProgress();
		renderPalette();
		queueTargetPreview();
	}

	function setDrawingStrategy(strategy) {
		if (!Object.hasOwn(DRAWING_STRATEGIES, strategy) || strategy === settings.drawingStrategy) return;
		settings.drawingStrategy = strategy;
		settings.smartPriority = strategy === "smart";
		if (strategy === "random" && !settings.drawingSeed) {
			settings.drawingSeed = (Math.random() * 0x100000000) >>> 0;
		}
		saveSettings();
		if (!state.monitoring && settings.workMode === "construction") {
			// La stratégie change uniquement l’ordre de construction. Les observations et achats restent en cache.
			targetRevision++;
			targetCache = null;
			queueTargetPreview();
		}
		void renderDrawingStrategy();
	}

	async function renderDrawingStrategy() {
		if (!ui.drawingStrategy) return;
		const { drawingStrategy: strategy, drawingSeed } = settings;
		ui.drawingStrategy.value = strategy;
		ui.drawingDescription.textContent = DRAWING_STRATEGIES[strategy].description;
		if (!ui.drawingSection.open) return;
		const key = strategy + ":" + drawingSeed;
		if (drawingPreviewKey === key) return;
		drawingPreviewKey = key;

		const colors = Int32Array.from([
			0, 0, 0, 0, 1,
			0, 0, 0, 1, 1,
			0, 0, 0, 1, 1,
			0, 0, 1, 1, 1,
			2, 0, 0, 1, 1,
		], (color) => PREVIEW_COLORS[color]);
		const indices = Uint32Array.from(colors, (_, index) => index);
		const ranks = new Uint32Array(colors.length).fill(1);
		const frequencies = new Map();
		for (const color of colors) frequencies.set(color, (frequencies.get(color) ?? 0) + 1);
		const order = await orderTargetIndices({ width: 5, height: 5, colors }, indices, ranks, frequencies, new Map(), strategy, drawingSeed);
		if (drawingPreviewKey !== key) return;
		order.forEach((pixel, rank) => { ranks[pixel] = rank + 1; });
		ui.drawingPreview.innerHTML = Array.from(ranks, (rank, pixel) =>
			'<span class="gpc-drawing-cell" style="--gpc-preview-color:' + colorHex(colors[pixel]) + '">' + rank + '</span>'
		).join("");
	}

	function bindDrawingStrategy(panel) {
		ui.drawingSection = panel.querySelector("#gpc-drawing-section");
		ui.drawingStrategy = panel.querySelector("#gpc-drawing-strategy");
		ui.drawingDescription = panel.querySelector("#gpc-drawing-description");
		ui.drawingPreview = panel.querySelector("#gpc-drawing-preview");
		ui.drawingStrategy.addEventListener("change", () => setDrawingStrategy(ui.drawingStrategy.value));
		ui.drawingSection.addEventListener("toggle", () => { void renderDrawingStrategy(); });
		void renderDrawingStrategy();
	}

	function mountUI() {
		if (document.getElementById("gpc-panel")) return;

		const style = document.createElement("style");
		style.textContent = `
			#gpc-panel {
				position: fixed;
				z-index: 2147483647;
				top: 18px;
				right: 18px;
				width: min(324px, calc(100vw - 16px));
				color: #e5e7eb;
				color-scheme: dark;
				background: #111827;
				border: 1px solid #374151;
				border-radius: 8px;
				box-shadow: 0 18px 48px rgba(0,0,0,.35);
				font: 12px/1.4 Arial, sans-serif;
				overflow: hidden;
				display: flex;
				flex-direction: column;
				max-height: calc(100vh - 16px);
				max-height: calc(100dvh - var(--gpc-top, 8px) - 8px);
			}
			#gpc-panel * { box-sizing: border-box; }
			#gpc-head {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 10px;
				padding: 10px 11px;
				background: #0f172a;
				border-bottom: 1px solid #253044;
				cursor: move;
			}
			.gpc-title {
				display: flex;
				align-items: center;
				gap: 7px;
				min-width: 0;
				font-weight: 700;
			}
			.gpc-title span:last-child {
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
			#gpc-dot {
				width: 8px;
				height: 8px;
				border-radius: 50%;
				background: #94a3b8;
			}
			#gpc-dot[data-status="running"] { background: #22c55e; }
			#gpc-dot[data-status="waiting"],
			#gpc-dot[data-status="syncing"] { background: #f59e0b; }
			#gpc-dot[data-status="buying"] { background: #a78bfa; }
			#gpc-dot[data-status="error"] { background: #ef4444; }
			#gpc-dot[data-status="done"] { background: #38bdf8; }
			#gpc-min {
				width: 26px;
				height: 24px;
				border: 1px solid #334155;
				border-radius: 6px;
				background: #172033;
				color: #cbd5e1;
				cursor: pointer;
				flex: 0 0 auto;
			}
			#gpc-body { min-height: 0; padding: 0 11px 11px; overflow-y: auto; overscroll-behavior: contain; }
			#gpc-toolbar { flex: 0 0 auto; padding: 8px 11px; border-bottom: 1px solid #253044; }
			#gpc-toolbar .gpc-row { flex-wrap: wrap; }
			.gpc-activity { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; }
			.gpc-activity select { flex: 1; }
			#gpc-panel.gpc-min #gpc-toolbar, #gpc-panel.gpc-min #gpc-body { display: none; }
			#gpc-panel.gpc-min { width: min(206px, calc(100vw - 16px)); }
			.gpc-row { display: flex; gap: 7px; align-items: center; }
			#gpc-head > .gpc-row { flex: 0 0 auto; }
			.gpc-row + .gpc-row { margin-top: 7px; }
			.gpc-btn {
				height: 30px;
				border: 1px solid #334155;
				border-radius: 6px;
				background: #1f2937;
				color: #e5e7eb;
				padding: 0 10px;
				font-weight: 700;
				cursor: pointer;
				white-space: nowrap;
			}
			.gpc-btn:hover { background: #263445; }
			.gpc-btn:disabled { opacity: .45; cursor: not-allowed; }
			.gpc-primary { background: #0f766e; border-color: #14b8a6; }
			.gpc-danger { background: #7f1d1d; border-color: #ef4444; }
			.gpc-grow { flex: 1; }
			#gpc-message {
				min-height: 18px;
				margin: 8px 0;
				color: #cbd5e1;
				overflow-wrap: anywhere;
			}
			#gpc-progress {
				height: 8px;
				border-radius: 999px;
				background: #020617;
				overflow: hidden;
				border: 1px solid #1f2937;
			}
			#gpc-bar {
				width: 0%;
				height: 100%;
				background: #22c55e;
				transition: width .18s ease;
			}
			.gpc-stats {
				display: grid;
				grid-template-columns: repeat(2, minmax(0, 1fr));
				gap: 6px;
				margin: 9px 0 10px;
			}
			.gpc-stat {
				min-width: 0;
				padding: 6px;
				border: 1px solid #273449;
				border-radius: 6px;
				background: #0b1220;
			}
			.gpc-stat b {
				display: block;
				color: #94a3b8;
				font-size: 10px;
				font-weight: 700;
			}
			.gpc-stat span {
				display: block;
				margin-top: 2px;
				font-size: 12px;
				font-weight: 700;
				font-variant-numeric: tabular-nums;
				overflow-wrap: anywhere;
			}
			.gpc-stat-total { grid-column: 1 / -1; }
			.gpc-stat-total span { font-size: 15px; }
			.gpc-pixel-summary { display: flex; flex-wrap: wrap; gap: 3px 10px; margin: 0 0 8px; }
			.gpc-section {
				margin-top: 10px;
				padding-top: 10px;
				border-top: 1px solid #273449;
			}
			details.gpc-section > summary { cursor: pointer; font-weight: 700; }
			details.gpc-section[open] > summary { margin-bottom: 7px; }
			details.gpc-section .gpc-btn { min-height: 30px; height: auto; white-space: normal; padding: 4px 9px; }
			#gpc-energy-controls, #gpc-auto-controls { min-width: 0; padding: 0; margin: 7px 0 0; border: 0; }
			.gpc-energy-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
			.gpc-energy-grid label { min-width: 0; display: grid; gap: 3px; }
			.gpc-energy-summary { display: flex; flex-wrap: wrap; gap: 2px 9px; margin-bottom: 6px; }
			#gpc-drawing-description { margin: 7px 0; }
			#gpc-drawing-preview { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 3px; width: min(100%, 140px); margin: 5px 0 0; }
			.gpc-drawing-cell { display: grid; place-items: center; aspect-ratio: 1; border-radius: 3px; background: var(--gpc-preview-color); color: #fff; font: 700 10px/1 Arial, sans-serif; }
			#gpc-maintenance-controls { min-width: 0; padding: 0; border: 0; margin: 0; }
			#gpc-maintenance-samples { white-space: pre-line; margin: 0 0 4px; overflow-wrap: anywhere; }
			.gpc-auto-summary { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 8px; margin: 7px 0; }
			.gpc-auto-summary dd { margin: 0; overflow-wrap: anywhere; }
			.gpc-auto-order { display: flex; flex-direction: column; gap: 4px; margin: 7px 0; }
			.gpc-auto-order .gpc-row { justify-content: space-between; margin-top: 0; }
			.gpc-check {
				display: flex;
				align-items: center;
				gap: 6px;
				color: #d1d5db;
			}
			.gpc-check input { accent-color: #14b8a6; }
			.gpc-input {
				width: 100%;
				height: 30px;
				border: 1px solid #334155;
				border-radius: 6px;
				background: #020617;
				color: #e5e7eb;
				padding: 0 8px;
				outline: none;
			}
			.gpc-input:focus { border-color: #14b8a6; }
			.gpc-muted { color: #94a3b8; font-size: 11px; }
			.gpc-palette-tools { flex-wrap: wrap; }
			.gpc-palette-tools .gpc-input { flex: 1 1 95px; }
			#gpc-palette-source { flex-basis: 100%; }
			.gpc-palette-pages { justify-content: space-between; }
			#gpc-palette-message { margin: 7px 0; }
			#gpc-palette-status { margin-top: 7px; }
			#gpc-palette-diagnostic { overflow-wrap: anywhere; }
			.gpc-palette-row { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 8px; align-items: start; padding: 7px 0; border-bottom: 1px solid #253044; }
			.gpc-palette-row small { color: #cbd5e1; }
			.gpc-swatch { width: 20px; height: 20px; border-radius: 4px; border: 1px solid #64748b; background: var(--gpc-chip-color, repeating-conic-gradient(#94a3b8 0% 25%, #293548 0% 50%) 0 / 8px 8px); }
			.gpc-palette-actions { display: flex; flex-wrap: wrap; gap: 6px; grid-column: 2; }
			.gpc-palette-actions button[aria-pressed="true"] { background: #164e63; border-color: #38bdf8; }
			.gpc-palette-filters { margin-bottom: 7px; }
			.gpc-palette-filters summary { cursor: pointer; }
			.gpc-palette-filters .gpc-check { margin-top: 5px; }
			.gpc-area-inputs {
				display: grid;
				grid-template-columns: repeat(2, minmax(0, 1fr));
				gap: 6px;
				margin-top: 6px;
			}
			#gpc-area-list { display: grid; gap: 6px; margin-top: 8px; }
			.gpc-area-item {
				display: grid;
				grid-template-columns: 1fr auto;
				gap: 3px 7px;
				align-items: center;
				padding: 7px;
				border: 1px solid #334155;
				border-radius: 6px;
				background: #0b1220;
			}
			.gpc-area-item strong { color: #e2e8f0; }
			.gpc-area-item[data-mode="include"] strong { color: #4ade80; }
			.gpc-area-item[data-mode="exclude"] strong { color: #f87171; }
			.gpc-area-remove { grid-row: 1 / 3; grid-column: 2; }
			#gpc-status {
				display: inline-flex;
				align-items: center;
				justify-content: center;
				min-width: 58px;
				border: 1px solid #334155;
				border-radius: 999px;
				padding: 2px 7px;
				color: #cbd5e1;
				background: #111827;
				font-size: 11px;
				font-weight: 700;
			}
		`;
		document.head.appendChild(style);

		const panel = document.createElement("div");
		panel.id = "gpc-panel";
		panel.lang = "fr";
		panel.innerHTML = `
			<div id="gpc-head">
				<div class="gpc-title"><span id="gpc-dot"></span><span>GhostPixel</span></div>
				<div class="gpc-row">
					<span id="gpc-status">${STATUS_LABELS.idle}</span>
					<button id="gpc-min" type="button" title="Réduire">-</button>
				</div>
			</div>
			<div id="gpc-toolbar">
				<label class="gpc-activity">Mode
					<select id="gpc-work-mode" class="gpc-input">
						<option value="construction">Construction</option>
						<option value="maintenance">Maintenance</option>
					</select>
				</label>
				<div class="gpc-row">
					<button id="gpc-start" class="gpc-btn gpc-primary gpc-grow" type="button">Démarrer</button>
					<button id="gpc-stop" class="gpc-btn gpc-danger gpc-grow" type="button">Arrêter</button>
					<button id="gpc-sync" class="gpc-btn" type="button">Synchroniser</button>
				</div>
			</div>
			<div id="gpc-body">
				<div id="gpc-message" role="status">Prêt</div>
				<div id="gpc-progress" role="progressbar" aria-label="Pixels confirmés" aria-valuenow="0"><div id="gpc-bar"></div></div>
				<div class="gpc-stats">
					<div class="gpc-stat gpc-stat-total"><b>Confirmés / sélectionnés</b><span id="gpc-count">0 / 0</span></div>
					<div class="gpc-stat"><b>Restants</b><span id="gpc-left">0</span></div>
					<div class="gpc-stat"><b>Énergie</b><span id="gpc-energy">Chargement…</span></div>
					<div class="gpc-stat"><b>Temps estimé</b><span id="gpc-eta">—</span></div>
					<div class="gpc-stat"><b>Débit observé</b><span id="gpc-rate">—</span></div>
				</div>
				<div class="gpc-pixel-summary gpc-muted">
					<span>Incorrects <b id="gpc-wrong-count">0</b></span>
					<span>Vides <b id="gpc-empty-count">0</b></span>
					<span>Non observés <b id="gpc-unknown-count">0</b></span>
				</div>
				<div class="gpc-energy-summary gpc-muted">
					<strong id="gpc-salvo-state"></strong>
					<span>Seuil attendu <b id="gpc-energy-threshold"></b></span>
					<span>Prochain groupe <b id="gpc-next-batch"></b></span>
				</div>
				<div class="gpc-energy-summary gpc-muted">
					<span>Surveillance <b id="gpc-maintenance-status">Inactive</b></span>
					<span>Pixels modifiés <b id="gpc-maintenance-changed">—</b></span>
					<span>Dernière vérification <time id="gpc-maintenance-time">—</time></span>
				</div>
				<details class="gpc-section">
					<summary>Surveillance du modèle</summary>
					<div id="gpc-maintenance-samples" class="gpc-muted"></div>
					<fieldset id="gpc-maintenance-controls" aria-label="Réglages de la surveillance">
						<label>Intervalle de vérification (s)
							<input id="gpc-maintenance-interval" class="gpc-input" type="number" min="${MIN_MAINTENANCE_INTERVAL}" max="${MAX_MAINTENANCE_INTERVAL}" step="1">
						</label>
						<label class="gpc-check">
							<input id="gpc-maintenance-auto" type="checkbox"> Surveiller automatiquement après la construction
						</label>
					</fieldset>
				</details>
				<details class="gpc-section" id="gpc-drawing-section">
					<summary>Stratégie de dessin</summary>
					<select id="gpc-drawing-strategy" class="gpc-input" aria-label="Stratégie de dessin" aria-describedby="gpc-drawing-description">
						${Object.entries(DRAWING_STRATEGIES).map(([value, { label }]) => '<option value="' + value + '">' + label + '</option>').join("")}
					</select>
					<div id="gpc-drawing-description" class="gpc-muted"></div>
					<div class="gpc-muted">Exemple d’ordre sur une grille de 5 × 5</div>
					<div id="gpc-drawing-preview" role="img" aria-label="Aperçu numéroté de l’ordre de traitement sur 25 pixels"></div>
				</details>
				<details class="gpc-section">
					<summary>Réglages de l’énergie</summary>
					<fieldset id="gpc-energy-controls" class="gpc-energy-grid" aria-label="Réglages de l’énergie">
						<label style="grid-column: 1 / -1;">Mode
							<select id="gpc-energy-mode" class="gpc-input">
								<option value="salvos">Salves</option>
								<option value="continuous">Continu</option>
							</select>
						</label>
						<label>Seuil de démarrage
							<input id="gpc-energy-start-value" class="gpc-input" type="number" min="1" step="1">
						</label>
						<label>Unité du démarrage
							<select id="gpc-energy-start-unit" class="gpc-input">
								<option value="percent">% de la capacité</option>
								<option value="absolute">Énergie absolue</option>
							</select>
						</label>
						<label>Seuil de reprise
							<input id="gpc-energy-resume-value" class="gpc-input" type="number" min="1" step="1">
						</label>
						<label>Unité de la reprise
							<select id="gpc-energy-resume-unit" class="gpc-input">
								<option value="percent">% de la capacité</option>
								<option value="absolute">Énergie absolue</option>
							</select>
						</label>
						<label>Réserve minimale
							<input id="gpc-energy-reserve" class="gpc-input" type="number" min="0" step="1">
						</label>
						<label>Groupe max. (0 = auto)
							<input id="gpc-energy-group-limit" class="gpc-input" type="number" min="0" max="${MAX_PIXELS_PER_REQUEST}" step="1">
						</label>
					</fieldset>
				</details>
				<details class="gpc-section">
					<summary>Améliorations automatiques</summary>
					<dl class="gpc-auto-summary">
						<dt>Solde</dt><dd id="gpc-auto-balance"></dd>
						<dt>Dépenses cumulées</dt><dd id="gpc-auto-spent"></dd>
						<dt>Ordre actif</dt><dd id="gpc-auto-active"></dd>
						<dt>Prochain achat</dt><dd id="gpc-auto-next"></dd>
					</dl>
					<div id="gpc-auto-message" class="gpc-muted" role="status"></div>
					<fieldset id="gpc-auto-controls" aria-label="Améliorations automatiques">
						<div class="gpc-energy-grid">
							<label style="grid-column: 1 / -1;">Politique budgétaire
								<select id="gpc-auto-policy" class="gpc-input">
									<option value="off">Désactivé</option>
									<option value="limited">Limité</option>
									<option value="unlimited">Illimité</option>
								</select>
							</label>
							<label>Réserve de Pixels
								<input id="gpc-auto-reserve" class="gpc-input" type="number" min="0" step="1">
							</label>
							<label>Plafond cumulé
								<input id="gpc-auto-limit" class="gpc-input" type="number" min="0" step="1">
							</label>
						</div>
						<div class="gpc-auto-order">
							${Object.entries(AUTO_UPGRADES).map(([type, { label }]) => `
								<div class="gpc-row" id="gpc-auto-row-${type}">
									<label class="gpc-check"><input id="gpc-auto-enabled-${type}" type="checkbox"> ${label}</label>
									<button id="gpc-auto-higher-${type}" class="gpc-btn" type="button" aria-label="Monter dans l’ordre : ${label}">↑</button>
								</div>
							`).join("")}
						</div>
						<button id="gpc-auto-authorize" class="gpc-btn" type="button"></button>
					</fieldset>
				</details>
				<details class="gpc-section" id="gpc-palette-section">
					<summary>Palette et filtres</summary>
					<details class="gpc-palette-filters">
						<summary>Règles de sélection</summary>
						<label class="gpc-check"><input id="gpc-priority-only" type="checkbox"> Limiter la sélection aux couleurs prioritaires</label>
						<label class="gpc-check"><input id="gpc-free" type="checkbox"> Inclure les couleurs de base gratuites</label>
						<label class="gpc-check"><input id="gpc-alpha" type="checkbox"> Inclure les pixels transparents</label>
						<div class="gpc-muted">En Construction, inclure la transparence peut effacer des pixels déjà peints.</div>
						<label class="gpc-check"><input id="gpc-wrong-color-priority" type="checkbox"> Corriger les couleurs incorrectes en priorité</label>
					</details>
					<div class="gpc-row gpc-palette-tools">
						<select id="gpc-palette-source" class="gpc-input" aria-label="Source des couleurs">
							<option value="model">Couleurs du modèle</option>
							<option value="account">Couleurs du compte</option>
						</select>
						<input id="gpc-palette-search" class="gpc-input" type="search" placeholder="#123456" aria-label="Code HEX exact">
						<button id="gpc-palette-refresh" class="gpc-btn" type="button">Actualiser</button>
					</div>
					<div id="gpc-palette-status" role="status"></div>
					<div id="gpc-palette-diagnostic" class="gpc-muted"></div>
					<div id="gpc-palette-message" class="gpc-muted" role="status"></div>
					<div id="gpc-palette-list"></div>
					<div id="gpc-palette-transparency" class="gpc-muted" hidden>Transparence (#00000000) : effacement, réglable séparément.</div>
					<div class="gpc-row gpc-palette-pages">
						<button id="gpc-palette-previous" class="gpc-btn" type="button">Précédent</button>
						<span id="gpc-palette-page"></span>
						<button id="gpc-palette-next" class="gpc-btn" type="button">Suivant</button>
					</div>
					<div class="gpc-row gpc-palette-tools">
						<button id="gpc-priority-clear" class="gpc-btn" type="button">Effacer les priorités</button>
						<button id="gpc-ignore-clear" class="gpc-btn" type="button">Effacer les exclusions</button>
					</div>
				</details>

				<details class="gpc-section">
					<summary>Zones de peinture</summary>
					<div class="gpc-muted" style="margin-top:3px;">Les rectangles verts délimitent la peinture. Les rectangles rouges marquent les exclusions.</div>
					<div class="gpc-row" style="margin-top:6px;">
						<select id="gpc-area-mode" class="gpc-input">
							<option value="include">Peindre dans cette zone</option>
							<option value="exclude">Exclure cette zone</option>
						</select>
					</div>
					<div class="gpc-area-inputs">
						<input id="gpc-area-x1" class="gpc-input" type="number" placeholder="X du coin 1">
						<input id="gpc-area-y1" class="gpc-input" type="number" placeholder="Y du coin 1">
						<input id="gpc-area-x2" class="gpc-input" type="number" placeholder="X du coin 2">
						<input id="gpc-area-y2" class="gpc-input" type="number" placeholder="Y du coin 2">
					</div>
					<div class="gpc-row">
						<button id="gpc-area-select" class="gpc-btn gpc-grow" type="button">Sélectionner sur la carte</button>
						<button id="gpc-area-add" class="gpc-btn gpc-grow" type="button">Ajouter</button>
					</div>
					<div class="gpc-row">
						<button id="gpc-area-clear" class="gpc-btn gpc-grow" type="button">Effacer les zones</button>
					</div>
					<div id="gpc-area-list" class="gpc-muted">Aucune</div>
				</details>
				<details class="gpc-section">
					<summary>Achats manuels et moniteur</summary>
					<div class="gpc-row"><button id="gpc-buy-colors" class="gpc-btn gpc-grow" type="button">Acheter les couleurs manquantes</button></div>
					<div class="gpc-row"><button id="gpc-buy-capacity" class="gpc-btn gpc-grow" type="button">Augmenter la capacité d’énergie</button></div>
					<div class="gpc-row"><button id="gpc-connect-monitor" class="gpc-btn gpc-grow" type="button">Connecter le moniteur</button></div>
				</details>
			</div>
		`;
		document.body.appendChild(panel);

		ui.panel = panel;
		ui.head = panel.querySelector("#gpc-head");
		ui.start = panel.querySelector("#gpc-start");
		ui.stop = panel.querySelector("#gpc-stop");
		ui.sync = panel.querySelector("#gpc-sync");
		ui.connectMonitor = panel.querySelector("#gpc-connect-monitor");
		ui.min = panel.querySelector("#gpc-min");
		ui.status = panel.querySelector("#gpc-status");
		ui.dot = panel.querySelector("#gpc-dot");
		ui.message = panel.querySelector("#gpc-message");
		ui.bar = panel.querySelector("#gpc-bar");
		ui.progress = panel.querySelector("#gpc-progress");
		ui.countText = panel.querySelector("#gpc-count");
		ui.remainingText = panel.querySelector("#gpc-left");
		ui.wrongText = panel.querySelector("#gpc-wrong-count");
		ui.emptyText = panel.querySelector("#gpc-empty-count");
		ui.unknownText = panel.querySelector("#gpc-unknown-count");
		ui.rateText = panel.querySelector("#gpc-rate");
		ui.energyText = panel.querySelector("#gpc-energy");
		ui.energyControls = panel.querySelector("#gpc-energy-controls");
		ui.salvoState = panel.querySelector("#gpc-salvo-state");
		ui.energyThreshold = panel.querySelector("#gpc-energy-threshold");
		ui.nextBatchSize = panel.querySelector("#gpc-next-batch");
		ui.workMode = panel.querySelector("#gpc-work-mode");
		ui.maintenanceControls = panel.querySelector("#gpc-maintenance-controls");
		ui.maintenanceStatus = panel.querySelector("#gpc-maintenance-status");
		ui.maintenanceChanged = panel.querySelector("#gpc-maintenance-changed");
		ui.maintenanceTime = panel.querySelector("#gpc-maintenance-time");
		ui.maintenanceSamples = panel.querySelector("#gpc-maintenance-samples");
		ui.autoControls = panel.querySelector("#gpc-auto-controls");
		ui.autoBalance = panel.querySelector("#gpc-auto-balance");
		ui.autoSpent = panel.querySelector("#gpc-auto-spent");
		ui.autoActive = panel.querySelector("#gpc-auto-active");
		ui.autoNext = panel.querySelector("#gpc-auto-next");
		ui.autoMessage = panel.querySelector("#gpc-auto-message");
		ui.etaText = panel.querySelector("#gpc-eta");
		ui.free = panel.querySelector("#gpc-free");
		ui.alpha = panel.querySelector("#gpc-alpha");
		ui.wrongColorPriority = panel.querySelector("#gpc-wrong-color-priority");
		ui.areaMode = panel.querySelector("#gpc-area-mode");
		ui.areaX1 = panel.querySelector("#gpc-area-x1");
		ui.areaY1 = panel.querySelector("#gpc-area-y1");
		ui.areaX2 = panel.querySelector("#gpc-area-x2");
		ui.areaY2 = panel.querySelector("#gpc-area-y2");
		ui.areaSelect = panel.querySelector("#gpc-area-select");
		ui.areaAdd = panel.querySelector("#gpc-area-add");
		ui.areaClear = panel.querySelector("#gpc-area-clear");
		ui.areaList = panel.querySelector("#gpc-area-list");
		ui.buyColors = panel.querySelector("#gpc-buy-colors");
		ui.buyCapacity = panel.querySelector("#gpc-buy-capacity");

		ui.free.checked = !!settings.includeFreeColors;
		ui.alpha.checked = !!settings.includeTransparent;
		ui.wrongColorPriority.checked = !!settings.prioritizeIncorrectColors;
		bindEnergySettings();
		bindAutomaticPurchases();
		bindPalette(panel);
		bindDrawingStrategy(panel);
		const maintenanceInterval = panel.querySelector("#gpc-maintenance-interval");
		const autoMaintenance = panel.querySelector("#gpc-maintenance-auto");
		ui.workMode.value = settings.workMode;
		maintenanceInterval.value = settings.maintenanceInterval;
		autoMaintenance.checked = settings.autoMaintenance;
		ui.workMode.addEventListener("change", () => {
			settings.workMode = ui.workMode.value;
			saveSettings();
			queueTargetPreview();
		});
		maintenanceInterval.addEventListener("change", () => {
			settings.maintenanceInterval = normalizeMaintenanceInterval(maintenanceInterval.value);
			maintenanceInterval.value = settings.maintenanceInterval;
			saveSettings();
		});
		autoMaintenance.addEventListener("change", () => {
			settings.autoMaintenance = autoMaintenance.checked;
			saveSettings();
		});
		panel.classList.toggle("gpc-min", !!settings.minimized);
		ui.min.textContent = settings.minimized ? "+" : "-";
		ui.min.title = settings.minimized ? "Développer" : "Réduire";
		if (Number.isFinite(settings.panelLeft) && Number.isFinite(settings.panelTop)) {
			panel.style.left = settings.panelLeft + "px";
			panel.style.top = settings.panelTop + "px";
			panel.style.right = "auto";
		}

		ui.start.addEventListener("click", startBot);
		ui.stop.addEventListener("click", requestStop);
		ui.sync.addEventListener("click", manualSync);
		ui.connectMonitor.addEventListener("click", connectAccountMonitor);
		ui.free.addEventListener("change", () => {
			settings.includeFreeColors = ui.free.checked;
			applyFiltersChanged();
		});
		ui.alpha.addEventListener("change", () => {
			settings.includeTransparent = ui.alpha.checked;
			applyFiltersChanged();
		});
		ui.wrongColorPriority.addEventListener("change", () => {
			settings.prioritizeIncorrectColors = ui.wrongColorPriority.checked;
			saveSettings();
			updateProgress();
			setStatus(
				"idle",
				settings.prioritizeIncorrectColors
					? "Les couleurs incorrectes seront corrigées en priorité."
					: "Ordre normal de peinture rétabli."
			);
		});
		ui.areaAdd.addEventListener("click", () => {
			if (addArea(areaFromInputs())) {
				ui.areaX1.value = "";
				ui.areaY1.value = "";
				ui.areaX2.value = "";
				ui.areaY2.value = "";
			}
		});
		ui.areaSelect.addEventListener("click", async () => {
			installPageBridge();
			if (typeof win.__gpcSelectArea !== "function") {
				setStatus("error", "La sélection sur la carte est momentanément indisponible.");
				return;
			}
			ui.areaSelect.disabled = true;
			ui.areaSelect.textContent = "Choisissez deux coins…";
			setStatus("syncing", "Cliquez sur deux coins de la zone sur la carte. Appuyez sur Échap pour annuler.");
			try {
				const points = await win.__gpcSelectArea();
				if (!points || points.length < 2) throw new Error("Sélection incomplète.");
				ui.areaX1.value = points[0].x;
				ui.areaY1.value = points[0].y;
				ui.areaX2.value = points[1].x;
				ui.areaY2.value = points[1].y;
				addArea(areaFromInputs());
			} catch (error) {
				setStatus("idle", error && error.message ? error.message : "Sélection annulée.");
			} finally {
				ui.areaSelect.disabled = false;
				ui.areaSelect.textContent = "Sélectionner sur la carte";
			}
		});
		ui.areaClear.addEventListener("click", () => {
			if (!settings.areas.length) return;
			if (!win.confirm("Effacer toutes les zones de peinture ?")) return;
			settings.areas = [];
			applyFiltersChanged(true);
			setStatus("idle", "Toutes les zones ont été effacées.");
		});
		ui.buyColors.addEventListener("click", async () => {
			ui.buyColors.disabled = true;
			try {
				const result = await buyMissingGhostColors();
				if (result && result.cancelled) return;
			} catch (error) {
				log("error", error);
				setStatus("error", error && error.message ? error.message : String(error));
			} finally {
				ui.buyColors.disabled = state.running;
			}
		});
		ui.buyCapacity.addEventListener("click", async () => {
			ui.buyCapacity.disabled = true;
			try {
				await buyAllAffordableEnergyCapacity();
			} catch (error) {
				log("error", error);
				setStatus("error", error && error.message ? error.message : String(error));
			} finally {
				ui.buyCapacity.disabled = state.running;
			}
		});
		ui.min.addEventListener("click", () => {
			settings.minimized = !settings.minimized;
			panel.classList.toggle("gpc-min", settings.minimized);
			ui.min.textContent = settings.minimized ? "+" : "-";
			ui.min.title = settings.minimized ? "Développer" : "Réduire";
			requestAnimationFrame(() => clampPanelToViewport(true));
			saveSettings();
		});

		enableDrag();
		clampPanelToViewport(false);
		window.addEventListener("resize", () => clampPanelToViewport(true));
		window.addEventListener("focus", () => {
			if (!state.running && !state.syncing) {
				void refreshAccount();
			}
		});
		window.addEventListener("gpc-account-purchase", () => {
			if (!purchaseInFlight) void refreshAccount();
		});
		renderAreas();
		setStatus("idle", "Prêt");
		setButtons();
		updateProgress();
		void refreshAccount();
		void loadBasePalette().then(renderPalette);
	}

	function clampPanelToViewport(persist) {
		if (!ui.panel || !ui.head) return;
		const rect = ui.panel.getBoundingClientRect();
		const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
		const minimumHeight = settings.minimized ? ui.head.offsetHeight : Math.min(rect.height, 240);
		const maxTop = Math.max(8, window.innerHeight - minimumHeight - 8);
		const left = Math.max(8, Math.min(maxLeft, rect.left));
		const top = Math.max(8, Math.min(maxTop, rect.top));

		ui.panel.style.left = left + "px";
		ui.panel.style.top = top + "px";
		ui.panel.style.setProperty("--gpc-top", top + "px");
		ui.panel.style.right = "auto";

		if (persist) {
			settings.panelLeft = Math.round(left);
			settings.panelTop = Math.round(top);
			saveSettings();
		}
	}

	function enableDrag() {
		let dragging = false;
		let offsetX = 0;
		let offsetY = 0;

		ui.head.addEventListener("pointerdown", (event) => {
			if (event.target === ui.min || event.target === ui.status) return;
			dragging = true;
			const rect = ui.panel.getBoundingClientRect();
			offsetX = event.clientX - rect.left;
			offsetY = event.clientY - rect.top;
			ui.head.setPointerCapture(event.pointerId);
		});

		ui.head.addEventListener("pointermove", (event) => {
			if (!dragging) return;
			const maxLeft = window.innerWidth - ui.panel.offsetWidth - 8;
			const minimumHeight = settings.minimized ? ui.head.offsetHeight : Math.min(ui.panel.offsetHeight, 240);
			const maxTop = window.innerHeight - minimumHeight - 8;
			const left = Math.max(8, Math.min(maxLeft, event.clientX - offsetX));
			const top = Math.max(8, Math.min(maxTop, event.clientY - offsetY));
			ui.panel.style.left = left + "px";
			ui.panel.style.top = top + "px";
			ui.panel.style.setProperty("--gpc-top", top + "px");
			ui.panel.style.right = "auto";
		});

		ui.head.addEventListener("pointerup", () => {
			if (!dragging) return;
			dragging = false;
			const rect = ui.panel.getBoundingClientRect();
			settings.panelLeft = Math.round(rect.left);
			settings.panelTop = Math.round(rect.top);
			saveSettings();
		});
	}

	win.ghostBot = {
		version: VERSION,
		start: startBot,
		stop: requestStop,
		sync: manualSync,
		settings: () => ({ ...settings }),
		clearCache() {
			modelCache = null;
			invalidateTargets();
			updateProgress();
		},
		ignoreColors(input) {
			const values = Array.isArray(input) ? input : parseColorList(input);
			settings.ignoredColors = values.map(toColorId).filter((id) => id !== null);
			applyFiltersChanged();
		},
		excludeColors(input) {
			const values = Array.isArray(input) ? input : parseColorList(input);
			settings.ignoredColors = values.map(toColorId).filter((id) => id !== null);
			applyFiltersChanged();
		},
		priorityColors(input) {
			const values = Array.isArray(input) ? input : parseColorList(input);
			settings.priorityColors = values.map(toColorId).filter((id) => id !== null);
			applyFiltersChanged();
		},
		smartPriority(enabled = true) {
			setDrawingStrategy(enabled ? "smart" : "color");
		},
		prioritizeIncorrectColors(enabled = true) {
			settings.prioritizeIncorrectColors = !!enabled;
			if (ui.wrongColorPriority) ui.wrongColorPriority.checked = settings.prioritizeIncorrectColors;
			saveSettings();
			updateProgress();
		},
		buyColor,
		buyMissingColors: buyMissingGhostColors,
		buyEnergyCapacity,
		buyAllEnergyCapacity: buyAllAffordableEnergyCapacity,
		paletteDebug: () => paletteDebug(),
		purchaseDebug: async () => {
			const availablePixels = await fetchAvailablePixels();
			let events = [];
			try {
				events = typeof win.__gpcGetFetchEvents === "function" ? win.__gpcGetFetchEvents() : [];
			} catch {}
			return {
				version: VERSION,
				availablePixels,
				energyCapacityUnits: Math.floor(availablePixels / 50),
				bridgePurchase: typeof win.__gpcMakePurchase === "function",
				bridgeUserData: typeof win.__gpcGetUserData === "function",
				fetchRecorder: typeof win.__gpcGetFetchEvents === "function",
				events: events.slice(-20),
			};
		},
		authDebug: async () => {
			const auth = await getAuthPayloadAsync();
			return {
				hasToken: !!auth.token,
				hasSubject: !!auth.subject,
				userId: auth.userId,
				bridge: typeof win.__gpcReadGlobal === "function",
				bridgePlacePixels: typeof win.__gpcPlacePixels === "function",
				bridgePurchase: typeof win.__gpcMakePurchase === "function",
				bridgeUserData: typeof win.__gpcGetUserData === "function",
				pageToken: !!readGlobal("tokenUser"),
				pageSubject: !!readGlobal("subject"),
				storedToken: !!storageGet("tokenUser"),
				storedUserId: storageGet("userID"),
			};
		},
	};

	win.ghostBotUI = {
		show: () => { if (ui.panel) ui.panel.style.display = "block"; },
		hide: () => { if (ui.panel) ui.panel.style.display = "none"; },
		toggle: () => {
			if (ui.panel) ui.panel.style.display = ui.panel.style.display === "none" ? "block" : "none";
		},
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", mountUI, { once: true });
	} else {
		mountUI();
	}

	log("log", "chargé", VERSION);
})();
