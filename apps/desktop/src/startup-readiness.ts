export type OptionalDesktopService = "browserCookies" | "ssh" | "tailnet";

export type OptionalDesktopReadiness = Readonly<
	Record<OptionalDesktopService, Promise<void>>
>;

type OptionalDesktopTasks = Readonly<
	Record<OptionalDesktopService, () => Promise<void>>
>;

/**
 * Starts the user-visible/runtime-critical path first, then launches unrelated
 * native initialization concurrently. Each readiness promise remains
 * awaitable by its first real consumer, so faster boot does not create races.
 */
export const startOptionalServicesAfterCritical = <Critical>(
	startCritical: () => Critical,
	tasks: OptionalDesktopTasks,
	onFailure: (
		service: OptionalDesktopService,
		cause: unknown,
	) => void = () => {},
): Readonly<{
	critical: Critical;
	readiness: OptionalDesktopReadiness;
}> => {
	const critical = startCritical();
	const start = (service: OptionalDesktopService): Promise<void> => {
		let task: Promise<void>;
		try {
			task = Promise.resolve(tasks[service]());
		} catch (cause) {
			task = Promise.reject(cause);
		}
		const readiness = task.catch((cause) => {
			onFailure(service, cause);
			throw cause;
		});

		void readiness.catch(() => undefined);
		return readiness;
	};
	return {
		critical,
		readiness: {
			ssh: start("ssh"),
			tailnet: start("tailnet"),
			browserCookies: start("browserCookies"),
		},
	};
};
