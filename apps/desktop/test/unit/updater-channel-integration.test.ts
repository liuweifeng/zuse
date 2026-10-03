import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPDATE_CHANNEL_SET } from "@zuse/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	directory: "",
	version: "0.22.0-preview.1",
	target: "0.22.0-preview.2",
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	finishDownload: () => {},
	cancelDownload: vi.fn(),
	hold: false,
}));
vi.mock("electron", async () => ({
	autoUpdater: Object.assign(new (await import("node:events")).EventEmitter(), {
		checkForUpdates: vi.fn(),
		quitAndInstall: vi.fn(),
	}),
	app: {
		getPath: () => state.directory,
		getVersion: () => state.version,
		isPackaged: true,
		exit: vi.fn(),
		quit: vi.fn(),
	},
	ipcMain: {
		handle: (name: string, fn: (...args: unknown[]) => unknown) =>
			state.handlers.set(name, fn),
	},
}));
vi.mock("electron-updater", async () => {
	const { EventEmitter } = await import("node:events");
	class CancellationToken {
		cancelled = false;
		cancel() {
			this.cancelled = true;
			state.cancelDownload();
		}
	}
	const autoUpdater = Object.assign(new EventEmitter(), {
		logger: {},
		autoDownload: true,
		autoInstallOnAppQuit: true,
		channel: "latest",
		allowPrerelease: false,
		allowDowngrade: false,
		setFeedURL: vi.fn(),
		quitAndInstall: vi.fn(),
		checkForUpdates: vi.fn(async () => {
			autoUpdater.emit("checking-for-update");
			autoUpdater.emit("update-available", { version: state.target });
			return { updateInfo: { version: state.target } };
		}),
		downloadUpdate: vi.fn(async (_token: CancellationToken) => {
			if (state.hold)
				await new Promise<void>((resolve) => {
					state.finishDownload = resolve;
				});
			autoUpdater.emit("update-downloaded", { version: state.target });
			return [];
		}),
	});
	return { autoUpdater, CancellationToken };
});
vi.mock("../../src/update-provider.ts", () => ({ channelProvider: vi.fn() }));

beforeEach(async () => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.useFakeTimers();
	state.handlers.clear();
	state.hold = false;
	state.target = "0.22.0-preview.2";
	state.directory = await mkdtemp(join(tmpdir(), "zuse-updater-integration-"));
	Object.defineProperty(process, "resourcesPath", {
		configurable: true,
		value: state.directory,
	});
	await writeFile(
		join(state.directory, "app-update.yml"),
		"provider: github\nowner: example\nrepo: app\n",
	);
});
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	const { autoUpdater } = await import("electron");
	autoUpdater.removeAllListeners();
	const updater = await import("electron-updater");
	updater.autoUpdater.removeAllListeners();
	await rm(state.directory, { recursive: true, force: true });
});

async function start() {
	const { startAutoUpdater, ...updater } = await import("../../src/updater.ts");
	const { autoUpdater } = await import("electron-updater");
	// Only the renderer attachment surface is needed by the updater.
	const window = {
		isDestroyed: () => false,
		webContents: { send: vi.fn(), on: vi.fn() },
	};
	updater.setEngineUpdateLifecycle({
		prepare: async () => "stopped",
		resume: vi.fn(),
	});
	startAutoUpdater(window);
	return { ...updater, autoUpdater };
}

describe("updater channel lifecycle", () => {
	beforeEach(() => {
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
	});
	it("waits for engine shutdown before installing and coalesces restart clicks", async () => {
		const updater = await start();
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		let finish: (value: "stopped") => void = () => {};
		const prepare = vi.fn(
			() =>
				new Promise<"stopped">((resolve) => {
					finish = resolve;
				}),
		);
		updater.setEngineUpdateLifecycle({ prepare, resume: vi.fn() });
		const installing = updater.installUpdate();
		await updater.installUpdate();
		expect(prepare).toHaveBeenCalledOnce();
		expect(updater.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
		expect(updater.getIsInstallingUpdate()).toBe(false);
		finish("stopped");
		await installing;
		expect(updater.autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
	});

	it("keeps attachment fenced until shutdown settles after a concurrent updater failure", async () => {
		const updater = await start();
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		let finish: (value: "stopped") => void = () => {};
		const resume = vi.fn();
		updater.setEngineUpdateLifecycle({
			prepare: () =>
				new Promise<"stopped">((resolve) => {
					finish = resolve;
				}),
			resume,
		});
		const installing = updater.installUpdate();
		updater.autoUpdater.emit("error", new Error("native update failure"));
		expect(resume).not.toHaveBeenCalled();
		finish("stopped");
		await installing;
		expect(resume).toHaveBeenCalledOnce();
		expect(updater.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
	});

	it("refuses active-engine updates and restores attachment after refusal", async () => {
		const updater = await start();
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		const resume = vi.fn();
		updater.setEngineUpdateLifecycle({ prepare: async () => "busy", resume });
		await updater.installUpdate();
		expect(updater.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
		expect(updater.autoUpdater.autoInstallOnAppQuit).toBe(false);
		expect(resume).toHaveBeenCalledOnce();
		expect(updater.getLastStatus()).toMatchObject({
			kind: "error",
			retryable: true,
		});
	});

	it("lets desktop quit while a busy engine keeps running without installing", async () => {
		const updater = await start();
		const { app } = await import("electron");
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		updater.setEngineUpdateLifecycle({
			prepare: async () => "busy",
			resume: vi.fn(),
		});
		expect(updater.installPendingUpdateOnQuit()).toBe(true);
		await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
		expect(updater.installPendingUpdateOnQuit()).toBe(false);
		expect(updater.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
	});

	it("never installs if engine shutdown cannot be verified", async () => {
		const updater = await start();
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		const resume = vi.fn();
		updater.setEngineUpdateLifecycle({
			prepare: async () => {
				throw new Error("shutdown timeout");
			},
			resume,
		});
		await updater.installUpdate();
		expect(updater.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
		expect(resume).toHaveBeenCalled();
	});

	it("still forces a stalled shutdown after a Linux install starts", async () => {
		const updater = await start();
		const { app } = await import("electron");
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		await updater.installUpdate();
		expect(updater.autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(4_000);
		expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
	});

	it("revokes a downloaded Preview before a switch and installs only the new Stable download", async () => {
		const updater = await start();
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		state.hold = true;
		state.target = "0.21.0";
		const changed = state.handlers.get(UPDATE_CHANNEL_SET)?.({}, "stable");
		await changed;
		await updater.installUpdate();
		expect(updater.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
		await vi.waitFor(() =>
			expect(updater.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2),
		);
		expect(updater.autoUpdater.allowDowngrade).toBe(true);
		state.finishDownload();
		await vi.waitFor(() =>
			expect(updater.getLastStatus()).toEqual({
				kind: "ready",
				version: "0.21.0",
			}),
		);
		await updater.installUpdate();
		expect(updater.autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
	});
	it("cancels an active transfer and ignores its late completion during a channel change", async () => {
		state.hold = true;
		const updater = await start();
		await vi.waitFor(() =>
			expect(updater.autoUpdater.downloadUpdate).toHaveBeenCalledOnce(),
		);
		const changed = state.handlers.get(UPDATE_CHANNEL_SET)?.({}, "stable");
		await vi.waitFor(() => expect(state.cancelDownload).toHaveBeenCalledOnce());
		state.finishDownload();
		await changed;
		expect(updater.getLastStatus().kind).not.toBe("ready");
		await updater.installUpdate();
		expect(updater.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
		state.hold = false;
		await vi.waitFor(() =>
			expect(updater.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2),
		);
		state.finishDownload();
	});
	it("does not authorize downgrade just because a Preview build has no preference file", async () => {
		const updater = await start();
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		expect(updater.autoUpdater.allowDowngrade).toBe(false);
	});
});

describe("macOS update installation handoff", () => {
	beforeEach(() => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
	});

	it("waits for native staging before starting the shutdown watchdog", async () => {
		const updater = await start();
		const { app, autoUpdater: nativeUpdater } = await import("electron");
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		await updater.installUpdate();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(app.exit).not.toHaveBeenCalled();
		nativeUpdater.emit("before-quit-for-update");
		await vi.advanceTimersByTimeAsync(4_000);
		expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
	});

	it("arms the watchdog even if the native quit starts synchronously", async () => {
		const updater = await start();
		const { app, autoUpdater: nativeUpdater } = await import("electron");
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		vi.mocked(nativeUpdater.quitAndInstall).mockImplementationOnce(() => {
			nativeUpdater.emit("before-quit-for-update");
		});
		await updater.installUpdate();
		await updater.installUpdate();
		nativeUpdater.emit("update-downloaded");
		await vi.advanceTimersByTimeAsync(4_000);
		expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
		expect(nativeUpdater.checkForUpdates).toHaveBeenCalledOnce();
		expect(nativeUpdater.quitAndInstall).toHaveBeenCalledOnce();
	});

	it("keeps the app open and unlocks retry when staging fails", async () => {
		const updater = await start();
		const { app, autoUpdater: nativeUpdater } = await import("electron");
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		await updater.installUpdate();
		updater.autoUpdater.emit(
			"error",
			new Error("signature verification failed"),
		);
		expect(updater.getIsInstallingUpdate()).toBe(false);
		expect(updater.getLastStatus()).toMatchObject({
			kind: "error",
			retryable: true,
		});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(app.exit).not.toHaveBeenCalled();
		nativeUpdater.emit("update-downloaded");
		expect(nativeUpdater.quitAndInstall).not.toHaveBeenCalled();
		updater.triggerUpdateCheck();
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		await updater.installUpdate();
		nativeUpdater.emit("update-downloaded");
		expect(nativeUpdater.quitAndInstall).toHaveBeenCalledOnce();
	});

	it("recovers from a synchronous staging failure", async () => {
		const updater = await start();
		const { app, autoUpdater: nativeUpdater } = await import("electron");
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		vi.mocked(nativeUpdater.checkForUpdates).mockImplementationOnce(() => {
			throw new Error("native updater unavailable");
		});
		await expect(updater.installUpdate()).resolves.toBeUndefined();
		expect(updater.getIsInstallingUpdate()).toBe(false);
		nativeUpdater.emit("update-downloaded");
		expect(nativeUpdater.quitAndInstall).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(app.exit).not.toHaveBeenCalled();
	});

	it("keeps timed-out native staging serialized and never quits on late completion", async () => {
		const updater = await start();
		const { app, autoUpdater: nativeUpdater } = await import("electron");
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		await updater.installUpdate();
		await vi.advanceTimersByTimeAsync(3 * 60_000);
		expect(updater.getIsInstallingUpdate()).toBe(false);
		expect(updater.getLastStatus()).toMatchObject({
			kind: "error",
			retryable: false,
		});
		updater.triggerUpdateCheck();
		await updater.installUpdate();
		await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
		expect(updater.autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
		expect(nativeUpdater.checkForUpdates).toHaveBeenCalledOnce();
		await expect(
			state.handlers.get(UPDATE_CHANNEL_SET)?.({}, "stable"),
		).rejects.toThrow();
		nativeUpdater.emit("update-downloaded");
		await vi.advanceTimersByTimeAsync(4_000);
		expect(app.exit).not.toHaveBeenCalled();
		expect(nativeUpdater.quitAndInstall).not.toHaveBeenCalled();
		expect(updater.getLastStatus()).toEqual({
			kind: "ready",
			version: state.target,
		});
		// Squirrel owns the staged version until restart; a feed switch must not
		// relabel it or schedule a second native download.
		await expect(
			state.handlers.get(UPDATE_CHANNEL_SET)?.({}, "stable"),
		).rejects.toThrow();
		updater.triggerUpdateCheck();
		await updater.installUpdate();
		expect(nativeUpdater.checkForUpdates).toHaveBeenCalledOnce();
		expect(nativeUpdater.quitAndInstall).toHaveBeenCalledOnce();
	});

	it.each([
		"error",
		"update-not-available",
	])("releases timed-out staging only after native %s", async (event) => {
		const updater = await start();
		const { autoUpdater: nativeUpdater } = await import("electron");
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		await updater.installUpdate();
		await vi.advanceTimersByTimeAsync(3 * 60_000);
		if (event === "error")
			updater.autoUpdater.emit("error", new Error("native staging failed"));
		else nativeUpdater.emit(event);
		expect(updater.getLastStatus()).toMatchObject({
			kind: "error",
			retryable: true,
		});
		await state.handlers.get(UPDATE_CHANNEL_SET)?.({}, "stable");
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		await updater.installUpdate();
		expect(nativeUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
		nativeUpdater.emit("update-downloaded");
		expect(nativeUpdater.quitAndInstall).toHaveBeenCalledOnce();
	});

	it("retries a failed native quit without replacing the staged update", async () => {
		const updater = await start();
		const { autoUpdater: nativeUpdater } = await import("electron");
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		vi.mocked(nativeUpdater.quitAndInstall).mockImplementationOnce(() => {
			throw new Error("quit failed");
		});
		await updater.installUpdate();
		nativeUpdater.emit("update-downloaded");
		expect(updater.getIsInstallingUpdate()).toBe(false);
		await expect(
			state.handlers.get(UPDATE_CHANNEL_SET)?.({}, "stable"),
		).rejects.toThrow();
		updater.triggerUpdateCheck();
		expect(updater.getLastStatus()).toEqual({
			kind: "ready",
			version: state.target,
		});
		await updater.installUpdate();
		expect(nativeUpdater.quitAndInstall).toHaveBeenCalledTimes(2);
		expect(nativeUpdater.checkForUpdates).toHaveBeenCalledOnce();
		expect(updater.autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
	});

	it("clears the staging deadline after successful staging", async () => {
		const updater = await start();
		const { autoUpdater: nativeUpdater } = await import("electron");
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		await updater.installUpdate();
		nativeUpdater.emit("update-downloaded");
		await vi.advanceTimersByTimeAsync(3 * 60_000);
		expect(updater.getIsInstallingUpdate()).toBe(true);
		expect(updater.getLastStatus().kind).toBe("ready");
	});

	it("clears a failed attempt's deadline before a retry", async () => {
		const updater = await start();
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		await updater.installUpdate();
		await vi.advanceTimersByTimeAsync(60_000);
		updater.autoUpdater.emit("error", new Error("staging failed"));
		updater.triggerUpdateCheck();
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		await updater.installUpdate();
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(updater.getIsInstallingUpdate()).toBe(true);
		expect(updater.getLastStatus().kind).toBe("ready");
	});

	it("does not replace the feed or channel during native staging", async () => {
		const updater = await start();
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		await updater.installUpdate();
		updater.triggerUpdateCheck();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(updater.autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
		await expect(
			state.handlers.get(UPDATE_CHANNEL_SET)?.({}, "preview"),
		).rejects.toThrow("An update is already installing");
	});
});
