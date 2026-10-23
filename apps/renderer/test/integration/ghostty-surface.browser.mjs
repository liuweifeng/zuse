import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const server = await createServer({
	configFile: false,
	root: new URL("../..", import.meta.url).pathname,
	server: { host: "127.0.0.1", port: 0 },
	plugins: [
		{
			name: "terminal-fixture",
			configureServer(server) {
				server.middlewares.use(
					"/terminal-fixture",
					async (_request, response) => {
						response.setHeader("Content-Type", "text/html");
						response.end(
							await server.transformIndexHtml(
								"/terminal-fixture",
								`
<!doctype html><style>
body { margin:0; background:#111; --background:#111; --foreground:#eee; --primary:#eee; --accent:#456; }
#terminal { width:800px; height:320px; transform:scale(.85); transform-origin:top left; }
[data-terminal-renderer] { position:relative; width:100%; height:100%; overflow:hidden; }
canvas { display:block; width:100%; height:100%; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; }
</style><div id="terminal"></div><script type="module">
import "@fontsource-variable/geist-mono";
import { GhosttySurface } from "/src/terminal/ghostty/surface.ts";
window.surface = new GhosttySurface();
surface.open(document.querySelector("#terminal"));
await surface.ready();
await document.fonts.ready;
surface.fit();
await surface.write("hello world\\r\\n" + "x".repeat(90) + "\\r\\nicons: \\uf013 \\ue0b0 \\ue718\\r\\n");
window.ready = true;
</script>`,
							),
						);
					},
				);
			},
		},
	],
});
let browser;
try {
	await server.listen();
	browser = await chromium.launch({
		executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
		headless: true,
		args: ["--no-sandbox"],
	});
	const page = await browser.newPage({ deviceScaleFactor: 2 });
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${server.resolvedUrls.local[0]}terminal-fixture`);
	await page.waitForFunction(() => window.ready);
	const geometry = await page.evaluate(() => {
		const s = window.surface;
		const bounds = s.canvas.getBoundingClientRect();
		return {
			x: bounds.x,
			y: bounds.y,
			scale: bounds.width / s.host.clientWidth,
			width: s.cellWidth,
			height: s.cellHeight,
			cols: s.cols,
		};
	});
	const point = (column, row = 0) => ({
		x: geometry.x + (4 + column * geometry.width) * geometry.scale,
		y: geometry.y + (2 + (row + 0.5) * geometry.height) * geometry.scale,
	});
	const start = point(0.1);
	const end = point(4.9);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(end.x, end.y, { steps: 8 });
	await page.mouse.up();
	assert.equal(
		await page.evaluate(() => surface.emulator.selectionText()),
		"hello",
	);
	assert.equal(
		await page.evaluate(() => {
			const data = new DataTransfer();
			surface.input.dispatchEvent(
				new ClipboardEvent("copy", { clipboardData: data, cancelable: true }),
			);
			return data.getData("text/plain");
		}),
		"hello",
	);
	const word = point(7.5);
	await page.mouse.dblclick(word.x, word.y);
	assert.equal(
		await page.evaluate(() => surface.emulator.selectionText()),
		"world",
	);
	const tailStart = point(80.1, 1);
	const tailEnd = point(89.9, 1);
	await page.mouse.move(tailStart.x, tailStart.y);
	await page.mouse.down();
	await page.mouse.move(tailEnd.x, tailEnd.y, { steps: 8 });
	await page.mouse.up();
	assert.equal(
		await page.evaluate(() => surface.emulator.selectionText()),
		"xxxxxxxxxx",
	);
	assert.equal(
		await page.evaluate(() => {
			const output = [];
			surface.onData((data) => output.push(data));
			surface.emulator.write("\x1b[?2004h");
			const clipboardData = new DataTransfer();
			clipboardData.setData("text/plain", "first\nsecond");
			surface.input.dispatchEvent(
				new ClipboardEvent("paste", { clipboardData, cancelable: true }),
			);
			return output.join("");
		}),
		"\x1b[200~first\nsecond\x1b[201~",
	);
	assert.equal(
		await page.evaluate(() =>
			document.fonts.check(
				'11px "Symbols Nerd Font Mono"',
				"\uf013\ue0b0\ue718",
			),
		),
		true,
	);
	assert.equal(
		await page.evaluate(
			() => surface.cellWidth === surface.context.measureText("M").width,
		),
		true,
	);
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.evaluate(() => {
		window.terminalOutput = [];
		window.bubbledKeys = [];
		document.addEventListener("keydown", (event) =>
			window.bubbledKeys.push(event.key),
		);
		surface.onData((data) => window.terminalOutput.push(data));
		surface.focus();
	});
	for (const [shortcut, expected] of [
		["Control+c", "\x03"],
		["Control+a", "\x01"],
		["Control+e", "\x05"],
		["Control+r", "\x12"],
		["Control+l", "\x0c"],
		["Control+u", "\x15"],
		["Control+w", "\x17"],
		["Control+d", "\x04"],
		["Control+z", "\x1a"],
		["Control+v", "\x16"],
		["Alt+b", "\x1bb"],
		["Alt+f", "\x1bf"],
		["ArrowUp", "\x1b[A"],
		["Control+ArrowLeft", "\x1b[1;5D"],
		["Tab", "\t"],
		["Shift+Tab", "\x1b[Z"],
		["Home", "\x1b[H"],
		["End", "\x1b[F"],
		["Backspace", "\x7f"],
		["Meta+Backspace", "\x15"],
		["Delete", "\x1b[3~"],
	]) {
		await page.evaluate(() => {
			window.terminalOutput.length = 0;
		});
		await page.keyboard.press(shortcut);
		assert.equal(
			await page.evaluate(() => window.terminalOutput.join("")),
			expected,
			shortcut,
		);
	}
	await page.keyboard.press("Control+Shift+c");
	assert.equal(
		await page.evaluate(() => navigator.clipboard.readText()),
		"xxxxxxxxxx",
	);
	await page.evaluate(async () => {
		window.terminalOutput.length = 0;
		await navigator.clipboard.writeText("pasted\ntext");
	});
	await page.keyboard.press("Control+Shift+v");
	await page.waitForFunction(() => window.terminalOutput.length > 0);
	assert.equal(
		await page.evaluate(() => window.terminalOutput.join("")),
		"\x1b[200~pasted\ntext\x1b[201~",
	);

	assert.deepEqual(
		await page.evaluate(() =>
			window.bubbledKeys.filter(
				(key) => !["Control", "Shift", "Alt", "Meta"].includes(key),
			),
		),
		[],
	);

	const remainingPixels = await page.evaluate(async () => {
		const paint = () =>
			new Promise((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(resolve)),
			);
		surface.emulator.clearSelection();
		await surface.write("\x1b[?25l\x1b[2J\x1b[H");
		await paint();
		await surface.write(`\x1b[1;${surface.cols}H☁`);
		await paint();
		await surface.write("\x1b[2J\x1b[H");
		await paint();
		const pixels = surface.context.getImageData(
			0,
			0,
			surface.canvas.width,
			surface.canvas.height,
		).data;
		const background = surface.emulator.capture().background;
		let remaining = 0;
		for (let index = 0; index < pixels.length; index += 4) {
			if (
				pixels[index] !== background.r ||
				pixels[index + 1] !== background.g ||
				pixels[index + 2] !== background.b
			)
				remaining++;
		}
		return remaining;
	});
	assert.equal(
		remainingPixels,
		0,
		"erased emoji must not leave pixels in the terminal margin",
	);

	assert.deepEqual(errors, []);
	await page.evaluate(() => surface.dispose());
	console.log(
		"Terminal browser checks passed: scaled drag, far-column selection, word selection, native copy, keyboard clipboard shortcuts, shell shortcuts, key isolation, bracketed paste, font metrics and symbols.",
	);
} finally {
	await browser?.close();
	await server.close();
}
