import { Context } from "effect";

/** Deployment gate, separate from user policy and provider permissions. */
export class MasterDeployment extends Context.Service<
	MasterDeployment,
	{ readonly crossEnvironment: boolean }
>()("zuse/MasterDeployment") {}
