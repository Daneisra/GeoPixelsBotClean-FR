const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");

const file = process.argv[2] ?? path.join(__dirname, "../ghostpixel-bot-clean.user.js");
const width = Number(process.argv[3] ?? 1500);
const strategy = process.argv[4] ?? "smart";
const pixels = width ** 2;
const data = new Uint8ClampedArray(pixels * 4);
for (let y = 0; y < width; y++) {
	for (let x = 0; x < width; x++) {
		const color = (Math.floor(x / 53) + Math.floor(y / 47)) % 3;
		data.set([18 + color * 21, 52, 86, 255], (y * width + x) * 4);
	}
}

const tileImage = { data: new Uint8ClampedArray(1000 * 1000 * 4) };
const stats = { tileRequests: 0 };
const context = vm.createContext({
	console: { log() {}, warn() {}, error() {} },
	setTimeout, clearTimeout, AbortSignal,
	Colors: ["#123456", "#273456", "#3C3456"],
	userID: 7,
	tokenUser: "benchmark-fixture",
	localStorage: { getItem: (key) => key === "ghostpixel_clean_settings"
		? JSON.stringify({ drawingStrategy: strategy, drawingSeed: 123456 }) : null },
	userData: { id: 7, colors: [0x123456, 0x273456, 0x3C3456] },
	ghostImageOriginalData: { width, height: width, data },
	ghostImageTopLeft: { x: -523, y: 679 },
	document: {
		readyState: "loading",
		addEventListener() {},
		getElementById() {},
		createElement(tag) {
			if (tag !== "canvas") return {};
			return { getContext: () => ({ translate() {}, scale() {}, drawImage() {}, getImageData: () => tileImage }) };
		},
	},
	Image: class {
		naturalWidth = 1000;
		naturalHeight = 1000;
		set src(_value) { this.onload(); }
	},
	async fetch(_url, init) {
		const { Tiles } = JSON.parse(init.body);
		stats.tileRequests += Tiles.length;
		return {
			ok: true,
			json: async () => ({
				ServerTimestamp: stats.tileRequests + 1,
				Tiles: Object.fromEntries(Tiles.map(({ x, y, timestamp }) => [
					x + "_" + y, timestamp ? { Type: "delta", Pixels: [[x + 510, y + 510, 0x123456]] }
						: { Type: "full", ColorWebP: "fixture" },
				])),
			}),
		};
	},
});
context.window = context;
const source = fs.readFileSync(file, "utf8").replace(
	'\tif (document.readyState === "loading") {',
	`	window.benchmark = {
		buildTargets, syncBoard, updateProgress,
		next: (cache, size) => typeof selectNextTargets === "function"
			? selectNextTargets(cache, size) : getRemainingTargets().slice(0, size),
	};
	if (document.readyState === "loading") {`
);
vm.runInContext(source, context);

async function measure(action) {
	const start = performance.now();
	let tick = start;
	let maxGap = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		maxGap = Math.max(maxGap, now - tick);
		tick = now;
	}, 5);
	try {
		const result = await action();
		maxGap = Math.max(maxGap, performance.now() - tick);
		return { result, ms: Math.round(performance.now() - start), maxGapMs: Math.round(maxGap) };
	} finally {
		clearInterval(timer);
	}
}

(async () => {
	const bot = context.benchmark;
	const build = await measure(() => bot.buildTargets());
	const full = await measure(() => bot.syncBoard());
	const delta = await measure(() => bot.syncBoard());
	const warm = await measure(async () => {
		for (let i = 0; i < 20; i++) {
			if (await bot.buildTargets() !== build.result) throw new Error("La sélection réutilise le même ordre.");
		}
	});
	const progress = await measure(() => {
		for (let i = 0; i < 20; i++) bot.updateProgress();
	});
	const groups = await measure(() => {
		for (let i = 0; i < 20; i++) {
			if (bot.next(build.result, 5000).length !== 5000) throw new Error("Le groupe doit contenir 5 000 pixels.");
		}
	});
	for (const sample of [build, full, delta, warm, progress, groups]) delete sample.result;
	console.log(JSON.stringify({ pixels, strategy, build, full, delta, warm, progress, groups, ...stats }, null, 2));
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
