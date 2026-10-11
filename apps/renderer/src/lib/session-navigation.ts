import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import { batchAtomUpdates } from "../state/registry.tsx";
import { useChatsStore } from "../store/chats.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { environmentShellData } from "./environment-entities.ts";
import { rendererWorkspaceSnapshot } from "./renderer-workspace.ts";
import { getActiveEnvironment } from "./rpc-client.ts";
import { switchToEnvironment } from "./switch-environment.ts";

/** Open a specific tab, not the chat's last-active tab, in its owning environment. */
export const openSession = async (ref: SessionRef): Promise<boolean> => {
	const resolveTarget = () => {
		const shell = environmentShellData(ref.environmentId);
		const session = Object.values(shell?.sessionsByProject ?? {})
			.flat()
			.find(
				(candidate) =>
					candidate.id === ref.sessionId && candidate.archivedAt === null,
			);
		const chat =
			session &&
			shell?.chatsByProject[session.projectId]?.find(
				(candidate) =>
					candidate.id === session.chatId && candidate.archivedAt === null,
			);
		return session && chat ? { session, chat } : null;
	};
	const target = resolveTarget();
	if (target === null) return false;
	const workspace = rendererWorkspaceSnapshot();
	if (getActiveEnvironment() !== ref.environmentId) {
		const chats = useChatsStore.getState();
		const sessions = useSessionsStore.getState();
		const previousEnvironment = getActiveEnvironment();
		const result = await switchToEnvironment({
			environmentId: ref.environmentId,
			folderId: target.session.projectId,
			chatId: target.chat.id,
			isCurrent: () =>
				rendererWorkspaceSnapshot() === workspace &&
				getActiveEnvironment() === previousEnvironment &&
				useChatsStore.getState().selectedChatId === chats.selectedChatId &&
				useChatsStore.getState().landingRevision === chats.landingRevision &&
				useSessionsStore.getState().selectedSessionId ===
					sessions.selectedSessionId,
		});
		if (!result.switched) return false;
	}
	if (
		getActiveEnvironment() !== ref.environmentId ||
		rendererWorkspaceSnapshot() !== workspace ||
		resolveTarget() === null
	)
		return false;
	batchAtomUpdates(() => {
		useUiStore.getState().setView("chat");
		useChatsStore.getState().select(target.chat.id);
		useSessionsStore.getState().select(ref.sessionId);
	});
	return true;
};
