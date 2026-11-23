const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../ghostpixel-bot-clean.user.js"), "utf8");
const settingsKey = "ghostpixel_clean_settings";
const flush = () => new Promise(setImmediate);

async function fixture({ pixels = 20, energy = 10, capacity = 10, settings = {}, bridge = true } = {}) {
	const nodes = new Map();
	const timers = new Map();
	const requests = [];
	const notifications = [];
	const painted = new Map();
	const account = { energy, capacity, paintResponses: [], status: 200, date: null, tick: 1, rate: 15 };
	let activeRequests = 0;
	let maxActiveRequests = 0;
	let nextTimer = 0;

	class Storage {
		constructor() { this.data = new Map(); }
		getItem(key) { return this.data.get(key) ?? null; }
		setItem(key, value) { this.data.set(key, String(value)); }
	}
	const storage = new Storage();
	storage.setItem(settingsKey, JSON.stringify(settings));

	function createElement(tag) {
		return {
			tag, value: "", dataset: {}, style: {}, classList: { toggle() {} },
			events: {},
			addEventListener(name, listener) { this.events[name] = listener; },
			getBoundingClientRect: () => ({ width: 320, height: 460, top: 10, left: 10 }),
			querySelector(selector) {
				if (!nodes.has(selector)) nodes.set(selector, createElement("div"));
				return nodes.get(selector);
			},
			appendChild() {},
			remove() {},
		};
	}

	function reply(status = 200, data = {}, headers = {}) {
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (key) => headers[key] ?? null },
			json: async () => data,
			text: async () => typeof data === "string" ? data : JSON.stringify(data),
		};
	}

	async function fetch(url, init) {
		const body = JSON.parse(init.body);
		if (url === "/GetUserData") {
			return reply(account.status, {
				energy: account.reportedEnergy ?? account.energy, maxEnergy: account.capacity, checkedTick: account.tick,
				energyRate: account.rate, pixels: 250,
			}, { Date: account.date, "Retry-After": account.readRetryAfter });
		}
		if (url === "/GetPixelsCached") {
			const tiles = Object.fromEntries(body.Tiles.map(({ x, y }) => [
				x + "_" + y,
				{ Type: "delta", Pixels: [...painted.values()].filter(([gridX]) => Math.floor(gridX / 1000) * 1000 === x) },
			]));
			return reply(200, { ServerTimestamp: 1, Tiles: tiles });
		}
		assert.equal(url, "/PlacePixels");
		assert.ok(init.signal instanceof AbortSignal);
		const batch = body.Pixels;
		requests.push(batch.length);
		activeRequests++;
		maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
		try {
			const outcome = account.paintResponses.shift() ?? {};
			if (outcome.wait) await outcome.wait;
			if (outcome.applied || !outcome.status && !outcome.throws) {
				assert.ok(batch.length > 0 && batch.length <= account.energy);
				account.energy -= batch.length;
				for (const { GridX, GridY, Color } of batch) painted.set(GridX + "," + GridY, [GridX, GridY, Color]);
			}
			if (outcome.throws) throw new TypeError("connection interrupted");
			return reply(outcome.status, outcome.text, outcome.headers);
		} finally {
			activeRequests--;
		}
	}

	const context = vm.createContext({
		console: { log() {}, warn() {}, error() {} },
		URL, AbortSignal, fetch, Storage, localStorage: storage,
		location: new URL("https://geopixels.net/"),
		innerWidth: 1000, innerHeight: 700,
		addEventListener() {},
		setTimeout(callback, ms) {
			if (ms === 500) return 0; // Le chargement asynchrone de la carte est hors de ce test.
			timers.set(++nextTimer, { callback, ms });
			return nextTimer;
		},
		clearTimeout: (id) => timers.delete(id),
		GM_notification: (notification) => notifications.push(notification),
		userID: 7, tokenUser: "local-fixture", subject: "local-fixture",
		currentEnergy: energy, maxEnergy: capacity, energyRate: account.rate,
		Colors: ["#FFFFFF"],
		ghostImageOriginalData: { width: pixels, data: new Uint8Array(pixels * 4).fill(255) },
		ghostImageTopLeft: { x: 0, y: 0 },
	});
	context.window = context;
	context.document = {
		readyState: "complete", createElement,
		getElementById: () => undefined,
		body: { appendChild() {} },
		head: {
			appendChild(element) {
				if (bridge && element.tag === "script") vm.runInContext(element.textContent, context);
			},
		},
	};
	vm.runInContext(source, context);
	await flush();

	return {
		account, requests, notifications, storage,
		bot: context.ghostBot,
		maxActiveRequests: () => maxActiveRequests,
		node: (name) => nodes.get("#gpc-" + name),
		async advance(expectedMs) {
			assert.equal(timers.size, 1);
			const [[id, { callback, ms }]] = timers;
			assert.equal(ms, expectedMs);
			timers.delete(id);
			callback();
			await flush();
		},
	};
}

const sizes = (session, ...expected) => assert.deepEqual(session.requests, expected);

test("les salves par défaut attendent la pleine capacité, y compris après une augmentation", async () => {
	const s = await fixture({ energy: 9, pixels: 15, settings: { minimized: true } });
	assert.equal(s.bot.version, "1.1.11");
	assert.equal(s.bot.settings().energyMode, "salvos");
	assert.equal(s.bot.settings().minimized, true);
	const run = s.bot.start();
	await flush();
	sizes(s);
	assert.equal(s.node("energy").textContent, "9 / 10");
	assert.equal(s.node("energy-threshold").textContent, 10);
	s.account.energy = 10;
	s.account.capacity = 12;
	await s.advance(15000);
	sizes(s);
	assert.equal(s.node("energy-threshold").textContent, 12);
	s.account.energy = 12;
	await s.advance(30000);
	sizes(s, 12);
	assert.equal(s.node("salvo-state").textContent, "Attente de la reprise");
	s.account.energy = 1;
	await s.advance(1200);
	sizes(s, 12);
	assert.equal(s.node("next-batch").textContent, 0);
	s.account.energy = 12;
	await s.advance(60000);
	await run;
	sizes(s, 12, 3);
	assert.equal(s.notifications.length, 1);
	assert.equal(s.node("count").textContent, "15 / 15");
});

test("le budget de la salve reste fixe malgré la recharge et préserve la réserve", async () => {
	const s = await fixture({ energy: 7, pixels: 8, settings: {
		startEnergyUnit: "absolute", startEnergyThreshold: 7, resumeEnergyThreshold: 50,
		energyReserve: 2, maxBatchSize: 3,
	} });
	const run = s.bot.start();
	await flush();
	sizes(s, 3);
	assert.equal(s.node("salvo-state").textContent, "Salve en cours");
	assert.equal(s.node("next-batch").textContent, 2);
	s.account.energy = 5;
	await s.advance(1200);
	sizes(s, 3, 2);
	assert.equal(s.account.energy, 3);
	await s.advance(1200);
	sizes(s, 3, 2);
	assert.equal(s.node("energy-threshold").textContent, 5);
	s.account.energy = 5;
	await s.advance(30000);
	await run;
	sizes(s, 3, 2, 3);
	assert.equal(s.account.energy, 2);
});

test("le mode Continu conserve les petits envois et les réglages sont sauvegardés", async () => {
	const s = await fixture({ energy: 0, pixels: 2, bridge: false });
	const mode = s.node("energy-mode");
	mode.value = "continuous";
	mode.events.change();
	const reserve = s.node("energy-reserve");
	reserve.value = "1";
	reserve.events.change();
	const saved = JSON.parse(s.storage.getItem(settingsKey));
	assert.equal(saved.energyMode, "continuous");
	assert.equal(saved.energyReserve, 1);
	assert.equal(s.node("energy-start-value").disabled, true);
	const run = s.bot.start();
	await flush();
	sizes(s);
	s.account.energy = 2;
	await s.advance(30000);
	sizes(s, 1);
	s.account.energy = 2;
	await s.advance(1200);
	await run;
	sizes(s, 1, 1);
});

test("le plafond de transport s’applique même avec un groupe automatique", async () => {
	const s = await fixture({ energy: 5001, capacity: 5001, pixels: 5001 });
	const run = s.bot.start();
	await flush();
	sizes(s, 5000);
	await s.advance(1200);
	await run;
	sizes(s, 5000, 1);
});

test("une limitation HTTP est respectée et un résultat incertain impose une resynchronisation", async () => {
	const s = await fixture({ energy: 4, capacity: 4, pixels: 4, settings: { maxBatchSize: 2 } });
	let release;
	const blocked = new Promise((resolve) => { release = resolve; });
	s.account.paintResponses.push(
		{ wait: blocked, status: 429, headers: { "Retry-After": "20" } },
		{ throws: true, applied: true },
	);
	const run = s.bot.start();
	await flush();
	await s.bot.start();
	sizes(s, 2);
	release();
	await flush();
	await s.advance(20000);
	await run;
	sizes(s, 2, 2);
	assert.equal(s.maxActiveRequests(), 1);
	assert.match(s.node("message").textContent, /résultat de l’envoi incertain/i);
	s.account.energy = 4;
	await s.bot.start();
	sizes(s, 2, 2, 2);
	assert.equal(s.node("count").textContent, "4 / 4");
});

test("une lecture refusée ou absente empêche de peindre avec le cache de la page", async () => {
	const s = await fixture({ energy: 10, capacity: 10 });
	s.account.status = 429;
	s.account.readRetryAfter = "25";
	const run = s.bot.start();
	await flush();
	sizes(s);
	s.account.status = 401;
	await s.advance(25000);
	await run;
	sizes(s);
	assert.equal(s.node("status").textContent, "Erreur");
});

test("un groupe trop volumineux ou une erreur serveur arrête les envois", async () => {
	const oversized = await fixture();
	oversized.account.paintResponses.push({ status: 413 });
	await oversized.bot.start();
	sizes(oversized, 10);
	assert.match(oversized.node("message").textContent, /réduisez la taille/i);

	const unavailable = await fixture({ bridge: false });
	unavailable.account.paintResponses.push({ status: 503 });
	await unavailable.bot.start();
	sizes(unavailable, 10);
	assert.match(unavailable.node("message").textContent, /résultat de l’envoi incertain/i);
});

test("un refus pour manque d’énergie ferme la salve et attend le seuil de reprise", async () => {
	const s = await fixture({ pixels: 4, settings: { resumeEnergyThreshold: 80 } });
	s.account.paintResponses.push({ status: 403, text: "Not enough energy" });
	const run = s.bot.start();
	await flush();
	sizes(s, 4);
	assert.equal(s.node("energy-threshold").textContent, 8);
	s.account.energy = 1;
	await s.advance(15000);
	sizes(s, 4);
	s.bot.stop();
	await run;
	assert.equal(s.node("status").textContent, "Arrêté");
});

test("la recharge estimée utilise l’heure de la réponse du serveur quand elle est disponible", async () => {
	const s = await fixture({ energy: 2, capacity: 10, pixels: 2 });
	s.account.tick = 100;
	const run = s.bot.start();
	await flush();
	sizes(s);
	s.account.date = new Date(220000).toUTCString();
	s.account.reportedEnergy = 2;
	s.account.energy = 10;
	await s.advance(60000);
	await run;
	sizes(s, 2);
});

test("un seuil en pourcentage s’arrondit à l’unité supérieure sans ajouter d’unité à un seuil exact", async () => {
	const s = await fixture({ energy: 7, capacity: 100, pixels: 2, settings: { startEnergyThreshold: 7 } });
	await s.bot.start();
	sizes(s, 2);
	const rounded = await fixture({ energy: 7, capacity: 101, pixels: 2, settings: { startEnergyThreshold: 7 } });
	const run = rounded.bot.start();
	await flush();
	sizes(rounded);
	assert.equal(rounded.node("energy-threshold").textContent, 8);
	rounded.bot.stop();
	await run;
});
