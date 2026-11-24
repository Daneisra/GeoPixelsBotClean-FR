const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../ghostpixel-bot-clean.user.js"), "utf8");
const settingsKey = "ghostpixel_clean_settings";
const flush = () => new Promise(setImmediate);

async function fixture({
	pixels = 20, energy = 10, capacity = 10, settings = {}, bridge = true,
	balance = 50, rate = 15, palette = [0xFFFFFF], template, ledger, allow = true,
	templateWidth = pixels, topLeft = { x: 0, y: 0 }, decodedTiles, initialAccountStatus = 200,
} = {}) {
	const nodes = new Map();
	const timers = new Map();
	const requests = [];
	const sent = [];
	const tileReads = [];
	const purchases = [];
	const confirmations = [];
	const notifications = [];
	const painted = new Map();
	const account = { energy, capacity, balance, colors: [...palette], paintResponses: [], purchaseResponses: [], status: initialAccountStatus, date: null, tick: 1, rate };
	const tariffs = { FasterRecharge: 500, EnergyCapacity: 50, Energy: 10, ExtraColor: 100 };
	const shop = new Map([
		["FasterRechargeInput", () => tariffs.FasterRecharge + " Pixels / -1s (cap at 15s)"],
		["EnergyCapacityInput", () => tariffs.EnergyCapacity + " Pixels / +5 max"],
		["EnergyInput", () => tariffs.Energy + " Pixels / +20 energy"],
		["ExtraColorInput", () => tariffs.ExtraColor + " Pixels / Any hex color allowed"],
	]);
	let activeRequests = 0;
	let maxActiveRequests = 0;
	let nextTimer = 0;
	let now = Date.now();

	class Storage {
		constructor() { this.data = new Map(); }
		getItem(key) { return this.data.get(key) ?? null; }
		setItem(key, value) { this.data.set(key, String(value)); }
	}
	const storage = new Storage();
	storage.setItem(settingsKey, JSON.stringify(settings));
	if (ledger) storage.setItem(settingsKey + "_purchases_7", ledger);

	function createElement(tag) {
		if (tag === "canvas" && decodedTiles) {
			let tile;
			return { getContext: () => ({
				translate() {}, scale() {},
				drawImage(image) { tile = decodedTiles.get(image.tile); },
				getImageData: () => ({ data: tile }),
			}) };
		}
		return {
			tag, value: "", dataset: {}, style: { setProperty() {} }, classList: { toggle() {} },
			events: {},
			setAttribute() {},
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
				energyRate: account.rate, pixels: account.balance * 5, colors: [...account.colors],
			}, { Date: account.date, "Retry-After": account.readRetryAfter });
		}
		if (url === "/GetPixelsCached") {
			tileReads.push(body.Tiles);
			if (account.tileStatus) return reply(account.tileStatus, {}, { "Retry-After": account.tileRetryAfter });
			if (account.readTiles) return reply(200, account.readTiles(body.Tiles));
			const tiles = Object.fromEntries(body.Tiles.map(({ x, y }) => [
				x + "_" + y,
				{ Type: "delta", Pixels: Array.from({ length: Math.max(0, Math.min(1000, pixels - x)) },
					(_, offset) => painted.get((x + offset) + "," + y) ?? [x + offset, y, -1]) },
			]));
			return reply(200, { ServerTimestamp: 1, Tiles: tiles });
		}
		if (url === "/MakePurchase") {
			assert.ok(init.signal instanceof AbortSignal);
			const { type, amount } = body;
			purchases.push({ type, amount });
			const response = account.purchaseResponses.shift() ?? {};
			if (response.change) response.change(account);
			if (!response.status && !response.throws && !response.noEffect) {
				const cost = type === "ExtraColor" && account.colors.length < 34 ? 0 : tariffs[type];
				assert.ok(account.balance >= cost);
				account.balance -= cost;
				if (type === "FasterRecharge") account.rate--;
				if (type === "EnergyCapacity") account.capacity += 5;
				if (type === "Energy") account.energy += 20;
				if (type === "ExtraColor") account.colors.push(amount);
			}
			if (response.throws) throw new TypeError("connection interrupted during purchase");
			return reply(response.status, response.text, response.headers);
		}
		assert.equal(url, "/PlacePixels");
		assert.ok(init.signal instanceof AbortSignal);
		const batch = body.Pixels;
		sent.push(batch.map(({ GridX, GridY }) => [GridX, GridY]));
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
			return reply(outcome.status, outcome.text ?? "Ok", outcome.headers);
		} finally {
			activeRequests--;
		}
	}

	const context = vm.createContext({
		console: { log() {}, warn() {}, error() {} },
		URL, AbortSignal, fetch, Storage, localStorage: storage,
		Date: class extends Date { static now() { return now; } },
		Image: class {
			naturalWidth = 1000;
			naturalHeight = 1000;
			set src(value) { this.tile = value.split(",")[1]; this.onload(); }
		},
		location: new URL("https://geopixels.net/"),
		innerWidth: 1000, innerHeight: 700,
		addEventListener() {},
		setTimeout(callback, ms) {
			if (ms === 0) { queueMicrotask(callback); return 0; }
			if (ms === 500) return 0; // Le chargement asynchrone de la carte est hors de ce test.
			timers.set(++nextTimer, { callback, ms });
			return nextTimer;
		},
		clearTimeout: (id) => timers.delete(id),
		GM_notification: (notification) => notifications.push(notification),
		navigator: { locks: { request: async (_name, _options, task) => task({}) } },
		confirm(message) { confirmations.push(message); return allow; },
		userID: 7, tokenUser: "local-fixture", subject: "local-fixture",
		currentEnergy: energy, maxEnergy: capacity, energyRate: account.rate,
		Colors: palette,
		ghostImageOriginalData: { width: templateWidth, data: template ?? new Uint8Array(pixels * 4).fill(255) },
		ghostImageTopLeft: topLeft,
	});
	context.window = context;
	context.document = {
		readyState: "complete", createElement,
		getElementById(id) {
			if (id === "freeColorNotice") return {};
			const quote = shop.get(id);
			if (quote) return { parentElement: { parentElement: { children: [{ textContent: quote() }] } } };
		},
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
		account, requests, sent, tileReads, purchases, confirmations, notifications, storage, painted, shop, tariffs,
		bot: context.ghostBot,
		maxActiveRequests: () => maxActiveRequests,
		node: (name) => nodes.get("#gpc-" + name),
		setTemplate(data) { context.ghostImageOriginalData = { width: templateWidth, data }; },
		elapse(ms) { now += ms; },
		async advance(expectedMs) {
			assert.equal(timers.size, 1);
			const [[id, { callback, ms }]] = timers;
			assert.equal(ms, expectedMs);
			timers.delete(id);
			now += ms;
			callback();
			await flush();
		},
	};
}

const sizes = (session, ...expected) => assert.deepEqual(session.requests, expected);

test("les salves par défaut attendent la pleine capacité, y compris après une augmentation", async () => {
	const s = await fixture({ energy: 9, pixels: 15, settings: { minimized: true } });
	assert.equal(s.bot.version, "1.1.14");
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
	assert.equal(s.node("next-batch").textContent, "En attente de recharge");
	assert.match(s.node("message").textContent, /prochain groupe attend la recharge/i);
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

const automatic = (enabled, overrides = {}) => ({
	policy: "unlimited", reserve: 0, limit: 0, enabled, accountId: 7, ...overrides,
});
const purchaseLedger = (session) => JSON.parse(session.storage.getItem(settingsKey + "_purchases_7"));

test("les achats exigent une autorisation explicite et toute modification la retire", async () => {
	const s = await fixture({ pixels: 1, balance: 100, settings: {
		automaticPurchases: automatic(["EnergyCapacity"], { accountId: null }),
	} });
	assert.equal(s.confirmations.length, 0);
	await s.bot.start();
	assert.deepEqual(s.purchases, []);
	s.node("auto-authorize").events.click();
	assert.equal(s.confirmations.length, 1);
	assert.equal(s.bot.settings().automaticPurchases.accountId, 7);
	s.node("auto-higher-EnergyCapacity").events.click();
	assert.equal(s.bot.settings().automaticPurchases.order[0], "EnergyCapacity");
	assert.equal(s.bot.settings().automaticPurchases.accountId, null);
	const denied = await fixture({ allow: false, settings: {
		automaticPurchases: automatic(["Energy"], { accountId: null }),
	} });
	denied.node("auto-authorize").events.click();
	assert.equal(denied.bot.settings().automaticPurchases.accountId, null);
});

test("le mode illimité dépense selon la priorité et réévalue pendant l’attente d’une salve", async () => {
	const s = await fixture({ energy: 0, capacity: 50, rate: 17, balance: 1060, settings: {
		automaticPurchases: automatic(["FasterRecharge", "EnergyCapacity", "Energy"], { reserve: 10 }),
	} });
	const run = s.bot.start();
	await flush();
	assert.deepEqual(s.purchases, [{ type: "FasterRecharge", amount: 1 }]);
	await s.advance(1200);
	await s.advance(1200);
	assert.deepEqual(s.purchases.map(({ type }) => type), ["FasterRecharge", "FasterRecharge", "EnergyCapacity"]);
	assert.equal(s.account.rate, 15);
	assert.equal(s.account.capacity, 55);
	assert.equal(s.account.balance, 10);
	assert.equal(purchaseLedger(s).spent, 1050);
	await s.advance(1200);
	assert.match(s.node("auto-message").textContent, /solde insuffisant/i);
	assert.match(s.node("auto-next").textContent, /Capacité énergétique/);
	assert.equal(s.node("energy").textContent, "0 / 55");
	sizes(s);
	s.bot.stop();
	await run;
});

test("le plafond limité et la réserve utilisent le tarif affiché et les dépenses cumulées", async () => {
	const config = automatic(["EnergyCapacity"], { policy: "limited", limit: 120, reserve: 20 });
	const s = await fixture({ energy: 0, balance: 150, settings: { automaticPurchases: config } });
	s.tariffs.EnergyCapacity = 60;
	const run = s.bot.start();
	await flush();
	await s.advance(1200);
	await s.advance(1200);
	assert.equal(s.purchases.length, 2);
	assert.equal(s.account.balance, 30);
	assert.equal(s.node("auto-spent").textContent, "120 Pixels");
	s.account.balance = 100;
	await s.advance(15000);
	assert.equal(s.purchases.length, 2);
	assert.match(s.node("auto-message").textContent, /plafond cumulé/i);
	const journal = s.storage.getItem(settingsKey + "_purchases_7");
	s.bot.stop();
	await run;

	const reloaded = await fixture({ energy: 0, balance: 100, ledger: journal, settings: { automaticPurchases: config } });
	const resumed = reloaded.bot.start();
	await flush();
	assert.deepEqual(reloaded.purchases, []);
	assert.equal(reloaded.node("auto-spent").textContent, "120 Pixels");
	reloaded.bot.stop();
	await resumed;
});

test("la recharge confirmée ajoute 20 points avant que la salve puisse peindre", async () => {
	const s = await fixture({ energy: 0, capacity: 15, balance: 10, pixels: 1, bridge: false, settings: {
		automaticPurchases: automatic(["Energy"]),
	} });
	await s.bot.start();
	assert.deepEqual(s.purchases, [{ type: "Energy", amount: 1 }]);
	assert.equal(s.account.energy, 19);
	assert.equal(s.account.balance, 0);
	assert.equal(purchaseLedger(s).spent, 10);
	sizes(s, 1);
});

test("les couleurs sont vérifiées sur la carte et les déblocages gratuits restent possibles sans Pixels", async () => {
	const s = await fixture({
		pixels: 4, balance: 0,
		template: new Uint8Array([255, 255, 255, 255, 0x12, 0x34, 0x56, 255, 0x65, 0x43, 0x21, 255, 0x32, 0x54, 0x76, 255]),
		settings: { ignoredColors: ["#325476"], automaticPurchases: automatic(["ExtraColor"]) },
	});
	s.painted.set("1,0", [1, 0, 0x123456]);
	const run = s.bot.start();
	await flush();
	assert.deepEqual(s.purchases, [{ type: "ExtraColor", amount: 0x654321 }]);
	assert.equal(purchaseLedger(s).spent, 0);
	await s.advance(1200);
	sizes(s, 2);
	await s.advance(1200);
	await run;
	assert.equal(s.purchases.length, 1);
	assert.equal(s.painted.get("2,0")[2], 0x654321);
	assert.equal(s.painted.has("3,0"), false);
});

test("une couleur payante respecte la réserve et utilise le tarif affiché", async () => {
	const fullPalette = [0xFFFFFF, ...Array.from({ length: 33 }, (_, index) => index)];
	const s = await fixture({
		pixels: 1, energy: 0, balance: 100, palette: fullPalette,
		template: new Uint8Array([0x12, 0x34, 0x56, 255]),
		settings: { automaticPurchases: automatic(["ExtraColor"], { reserve: 5 }) },
	});
	const run = s.bot.start();
	await flush();
	assert.deepEqual(s.purchases, []);
	assert.match(s.node("auto-next").textContent, /100 Pixels/);
	s.account.balance = 105;
	await s.advance(15000);
	assert.deepEqual(s.purchases, [{ type: "ExtraColor", amount: 0x123456 }]);
	assert.equal(s.account.balance, 5);
	assert.equal(purchaseLedger(s).spent, 100);
	s.bot.stop();
	await run;
});

test("une réponse supposée favorable sans effet vérifié bloque toute répétition après rechargement", async () => {
	const config = automatic(["EnergyCapacity"], { policy: "limited", limit: 50 });
	const s = await fixture({ energy: 0, balance: 100, settings: { automaticPurchases: config } });
	s.account.purchaseResponses.push({ noEffect: true });
	const run = s.bot.start();
	await flush();
	assert.equal(s.purchases.length, 1);
	assert.equal(purchaseLedger(s).spent, 0);
	assert.match(s.node("auto-message").textContent, /résultat non confirmé/i);
	const journal = s.storage.getItem(settingsKey + "_purchases_7");
	assert.equal(purchaseLedger(s).pending.type, "EnergyCapacity");
	s.bot.stop();
	await run;

	const reloaded = await fixture({ energy: 0, balance: 100, ledger: journal, settings: { automaticPurchases: config } });
	const resumed = reloaded.bot.start();
	await flush();
	assert.deepEqual(reloaded.purchases, []);
	assert.match(reloaded.node("auto-message").textContent, /achat précédent non confirmé/i);
	reloaded.account.capacity = 15;
	reloaded.account.balance = 50;
	await reloaded.advance(15000);
	assert.equal(purchaseLedger(reloaded).spent, 50);
	assert.equal(purchaseLedger(reloaded).pending, null);
	assert.deepEqual(reloaded.purchases, []);
	reloaded.bot.stop();
	await resumed;
});

test("un délai réseau ambigu n’essaie jamais un autre chemin d’achat", async () => {
	const s = await fixture({ energy: 0, balance: 100, settings: { automaticPurchases: automatic(["EnergyCapacity"]) } });
	s.account.purchaseResponses.push({ throws: true });
	const run = s.bot.start();
	await flush();
	assert.equal(s.purchases.length, 1);
	assert.equal(purchaseLedger(s).pending.type, "EnergyCapacity");
	await s.advance(15000);
	assert.equal(s.purchases.length, 1);
	s.bot.stop();
	await run;
});

test("l’absence d’un tarif exploitable bloque l’achat prioritaire", async () => {
	const s = await fixture({ pixels: 1, balance: 100, settings: {
		automaticPurchases: automatic(["EnergyCapacity", "Energy"]),
	} });
	s.shop.delete("EnergyCapacityInput");
	await s.bot.start();
	assert.deepEqual(s.purchases, []);
	assert.match(s.node("auto-message").textContent, /non vérifiable/i);
});

test("une observation partielle sépare les pixels confirmés, incorrects, vides et inconnus", async () => {
	const s = await fixture({ pixels: 4 });
	s.account.readTiles = () => ({
		ServerTimestamp: 20,
		Tiles: { "0_0": { Type: "delta", Pixels: [...[
			[0, 0, 0xFFFFFF], [1, 0, 0], [2, 0, -1], [null, 0, 0], [3, 0, 1.5],
		], ...s.painted.values()] } },
	});
	await s.bot.sync();
	assert.equal(s.node("count").textContent, "1 / 4");
	assert.equal(s.node("wrong-count").textContent, "1");
	assert.equal(s.node("empty-count").textContent, "1");
	assert.equal(s.node("unknown-count").textContent, "1");
	assert.equal(s.node("eta").textContent, "—");
	const run = s.bot.start();
	await flush();
	await s.advance(1200);
	await run;
	assert.deepEqual(s.sent, [[[1, 0], [2, 0]]]);
	assert.ok(s.tileReads.every(([tile]) => tile.timestamp === 0));
	assert.equal(s.node("count").textContent, "3 / 4");
	assert.match(s.node("message").textContent, /non observés/);
	assert.equal(s.notifications.length, 0);
});

test("les compteurs réagissent aux seuls deltas et ignorent une réponse plus ancienne", async () => {
	const s = await fixture({ pixels: 3 });
	let version = 0;
	const edits = [
		{ stamp: 20, pixels: [[0, 0, 0xFFFFFF], [1, 0, 0], [2, 0, -1]] },
		{ stamp: 21, pixels: [[1, 0, 0xFFFFFF]] },
		{ stamp: 19, pixels: [[0, 0, 0]] },
	];
	s.account.readTiles = () => {
		const { stamp, pixels } = edits[version++];
		return { ServerTimestamp: stamp, Tiles: { "0_0": { Type: "delta", Pixels: pixels } } };
	};
	await s.bot.sync();
	await s.bot.sync();
	await s.bot.sync();
	assert.deepEqual(s.tileReads.map(([tile]) => tile.timestamp), [0, 20, 21]);
	assert.equal(s.node("count").textContent, "2 / 3");
	assert.equal(s.node("wrong-count").textContent, "0");
	assert.equal(s.node("empty-count").textContent, "1");
	assert.equal(s.node("unknown-count").textContent, "0");
});

test("les tuiles complètes respectent les limites et l’orientation des coordonnées négatives", async () => {
	const decodedTiles = new Map();
	for (const [x, y, rgba] of [
		[-1, 0, [255, 255, 255, 255]], [0, 0, [0, 0, 0, 255]],
		[-1, -1, [0, 0, 0, 0]], [0, -1, [255, 255, 255, 255]],
	]) {
		const originX = Math.floor(x / 1000) * 1000;
		const originY = Math.floor(y / 1000) * 1000;
		const data = new Uint8Array(1000 * 1000 * 4);
		const offset = ((originY + 999 - y) * 1000 + x - originX) * 4;
		data.set(rgba, offset);
		decodedTiles.set(originX + "_" + originY, data);
	}
	const s = await fixture({ pixels: 4, templateWidth: 2, topLeft: { x: -1, y: 0 }, decodedTiles });
	s.account.readTiles = (tiles) => ({
		ServerTimestamp: 30,
		Tiles: Object.fromEntries(tiles.map(({ x, y }) => [
			x + "_" + y, { Type: "full", ColorWebP: x + "_" + y },
		])),
	});
	await s.bot.sync();
	assert.equal(s.tileReads[0].length, 4);
	assert.equal(s.node("count").textContent, "2 / 4");
	assert.equal(s.node("wrong-count").textContent, "1");
	assert.equal(s.node("empty-count").textContent, "1");
	assert.equal(s.node("unknown-count").textContent, "0");
});

test("la priorité intelligente conserve la taille des régions à travers les frontières des tuiles", async () => {
	const pixels = 1003;
	const template = new Uint8Array(pixels * 4).fill(255);
	for (const x of [998, 999, 1000, 1002]) template.set([0x12, 0x34, 0x56, 255], x * 4);
	template.set([0x56, 0x34, 0x12, 255], 1001 * 4);
	const s = await fixture({ pixels, template, energy: 5, capacity: 5, palette: [0xFFFFFF, 0x123456, 0x563412] });
	const run = s.bot.start();
	await flush();
	assert.deepEqual(s.sent, [[[1001, 0], [1002, 0], [998, 0], [999, 0], [1000, 0]]]);
	assert.equal(s.node("count").textContent, "5 / " + new Intl.NumberFormat("fr-FR").format(pixels));
	s.bot.stop();
	await run;
});

test("les pixels incorrects prennent la priorité sur les pixels vides si l’option est active", async () => {
	const s = await fixture({ pixels: 3, energy: 1, capacity: 1, settings: { prioritizeIncorrectColors: true } });
	s.painted.set("2,0", [2, 0, 0]);
	const run = s.bot.start();
	await flush();
	assert.deepEqual(s.sent, [[[2, 0]]]);
	s.bot.stop();
	await run;
});

test("un pixel modifié après acceptation est signalé et ne repart pas dans la même session", async () => {
	const s = await fixture({ pixels: 2, energy: 2, capacity: 2, settings: { maxBatchSize: 1 } });
	const run = s.bot.start();
	await flush();
	assert.deepEqual(s.sent, [[[0, 0]]]);
	s.painted.delete("0,0");
	s.elapse(30000);
	await s.advance(1200);
	assert.deepEqual(s.sent, [[[0, 0]], [[1, 0]]]);
	s.account.energy = 2;
	await s.advance(1200);
	await run;
	assert.equal(s.sent.length, 2);
	assert.match(s.node("message").textContent, /déjà envoyés ont changé/);
	assert.equal(s.node("count").textContent, "1 / 2");
});

test("un nouveau modèle de même taille remplace le cache pendant un envoi", async () => {
	const s = await fixture({ pixels: 1, energy: 2, capacity: 2, palette: [0xFFFFFF, 0x123456] });
	let release;
	s.account.paintResponses.push({ wait: new Promise((resolve) => { release = resolve; }) });
	const run = s.bot.start();
	await flush();
	s.setTemplate(new Uint8Array([0x12, 0x34, 0x56, 255]));
	release();
	await flush();
	await s.advance(1200);
	await run;
	assert.equal(s.sent.length, 2);
	assert.equal(s.painted.get("0,0")[2], 0x123456);
});

test("une réponse HTTP réussie sans confirmation GeoPixels laisse le groupe non observé", async () => {
	const s = await fixture({ pixels: 1 });
	s.account.paintResponses.push({ status: 200, text: "Incomplete" });
	await s.bot.start();
	sizes(s, 1);
	assert.equal(s.node("count").textContent, "0 / 1");
	assert.equal(s.node("unknown-count").textContent, "1");
	assert.match(s.node("message").textContent, /résultat de l’envoi incertain/i);
	assert.equal(s.notifications.length, 0);
});

test("l’estimation utilise le débit observé et affiche les durées longues en jours et heures", async () => {
	const s = await fixture({ pixels: 4, energy: 4, capacity: 4, settings: { maxBatchSize: 1 } });
	const run = s.bot.start();
	await flush();
	assert.equal(s.node("eta").textContent, "—");
	s.elapse(3 * 86400 * 1000);
	await s.advance(1200);
	assert.match(s.node("eta").textContent, /^3 j 0 h$/);
	assert.match(s.node("rate").textContent, /px\/min$/);
	s.bot.stop();
	await run;
});

test("les ressources provisoires n’apparaissent pas avant une lecture réelle de l’énergie", async () => {
	const s = await fixture({ pixels: 1, energy: 30, capacity: 30, initialAccountStatus: 503 });
	assert.equal(s.node("energy").textContent, "Chargement…");
	s.account.status = 200;
	s.account.energy = 22;
	s.account.capacity = 45;
	await s.bot.sync();
	assert.equal(s.node("energy").textContent, "22 / 45");
});

test("les réglages de surveillance sont normalisés et conservés après rechargement", async () => {
	const s = await fixture();
	assert.equal(s.node("work-mode").value, "construction");
	assert.equal(s.node("maintenance-interval").value, 30);
	s.node("work-mode").value = "maintenance";
	s.node("work-mode").events.change();
	s.node("maintenance-interval").value = 3;
	s.node("maintenance-interval").events.change();
	assert.equal(s.node("maintenance-interval").value, 10);
	s.node("maintenance-auto").checked = true;
	s.node("maintenance-auto").events.change();
	const reloaded = await fixture({ settings: JSON.parse(s.storage.getItem(settingsKey)) });
	assert.equal(reloaded.node("work-mode").value, "maintenance");
	assert.equal(reloaded.node("maintenance-interval").value, 10);
	assert.equal(reloaded.node("maintenance-auto").checked, true);
});

test("la maintenance suit les deltas et signale chaque pixel modifié une fois, sans achat ni placement", async () => {
	const s = await fixture({
		pixels: 2, template: new Uint8Array([255, 255, 255, 255, 0x12, 0x34, 0x56, 255]),
		settings: { workMode: "maintenance", maintenanceInterval: 12, automaticPurchases: automatic(["EnergyCapacity", "ExtraColor"]) },
	});
	let version = 0;
	const edits = [
		[[0, 0, 0xFFFFFF], [1, 0, 0x123456]],
		[[0, 0, 0], [0, 0, 0x123456], [1, 0, -1]],
		[],
	];
	s.account.readTiles = () => ({
		ServerTimestamp: 20 + version, Tiles: { "0_0": { Type: "delta", Pixels: edits[version++] } },
	});
	const run = s.bot.start();
	await flush();
	assert.equal(s.node("maintenance-status").textContent, "Active");
	assert.equal(s.node("maintenance-changed").textContent, "0");
	assert.equal(s.node("count").textContent, "2 / 2");
	assert.equal(s.node("work-mode").disabled, true);
	const firstCheck = s.node("maintenance-time").dateTime;
	await s.advance(12000);
	assert.equal(s.node("maintenance-changed").textContent, "2");
	assert.match(s.node("maintenance-samples").textContent, /0, 0 · #FFFFFF → #123456/);
	assert.match(s.node("maintenance-samples").textContent, /1, 0 · #123456 → vide/);
	assert.ok(s.node("maintenance-time").dateTime > firstCheck);
	await s.advance(12000);
	assert.equal(s.node("maintenance-changed").textContent, "0");
	assert.equal(s.node("maintenance-samples").textContent, "");
	assert.deepEqual(s.tileReads.map(([tile]) => tile.timestamp), [0, 20, 21]);
	assert.deepEqual(s.purchases, []);
	sizes(s);
	s.bot.stop();
	await run;
	assert.equal(s.node("maintenance-status").textContent, "Arrêtée");
	assert.equal(s.node("work-mode").disabled, false);
});

test("un refus temporaire de la carte conserve la dernière vérification et respecte Retry-After", async () => {
	const s = await fixture({ pixels: 1, settings: { workMode: "maintenance", maintenanceInterval: 10 } });
	const run = s.bot.start();
	await flush();
	const previous = s.node("maintenance-time").dateTime;
	s.account.tileStatus = 429;
	s.account.tileRetryAfter = "22";
	await s.advance(10000);
	assert.equal(s.node("maintenance-status").textContent, "Vérification interrompue");
	assert.equal(s.node("maintenance-time").dateTime, previous);
	delete s.account.tileStatus;
	await s.advance(22000);
	assert.equal(s.node("maintenance-status").textContent, "Active");
	assert.ok(s.node("maintenance-time").dateTime > previous);
	s.bot.stop();
	await run;
});

test("la construction terminée bascule automatiquement en maintenance et conserve le mode", async () => {
	const s = await fixture({ pixels: 1, settings: { autoMaintenance: true } });
	const run = s.bot.start();
	await flush();
	sizes(s, 1);
	assert.equal(s.node("maintenance-status").textContent, "Active");
	assert.equal(s.node("work-mode").value, "maintenance");
	assert.equal(JSON.parse(s.storage.getItem(settingsKey)).workMode, "maintenance");
	s.painted.delete("0,0");
	await s.advance(30000);
	assert.equal(s.node("maintenance-changed").textContent, "1");
	sizes(s, 1);
	s.bot.stop();
	await run;
});

test("un modèle incomplet en raison d’une couleur non acquise ne déclenche pas le basculement", async () => {
	const s = await fixture({
		pixels: 2, template: new Uint8Array([255, 255, 255, 255, 0x12, 0x34, 0x56, 255]),
		settings: { autoMaintenance: true },
	});
	await s.bot.start();
	sizes(s, 1);
	assert.equal(s.node("work-mode").value, "construction");
	assert.equal(s.node("maintenance-status").textContent, "Inactive");
	assert.match(s.node("message").textContent, /surveillance automatique reportée/i);
});
