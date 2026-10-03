import { isEngineIdle } from "../runtime-idle.ts";

/** The idle decision and closing admission share the command/job transaction boundary. */
export const prepareIdleShutdown = (
	options: Parameters<typeof isEngineIdle>[0],
) => options.domain.admission.closeIf(isEngineIdle(options));
