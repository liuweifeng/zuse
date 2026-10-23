import type { RepositorySettings, RuntimeMode } from "@zuse/contracts";

/**
 * The permission mode a new chat or session starts in: the repository's
 * override, else the user's global default. Shared by the renderer (new
 * chats) and the server (Zot coordinators and workers).
 */
export const effectiveChatRuntimeMode = (
	globalDefault: RuntimeMode,
	repositorySettings: Pick<RepositorySettings, "defaultRuntimeMode"> | null,
): RuntimeMode => repositorySettings?.defaultRuntimeMode ?? globalDefault;
