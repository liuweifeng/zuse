import "@zuse/i18n/english/chat";
import { useMessages } from "@zuse/i18n/react";
import { View } from "react-native";
import { Button } from "~/components/ui/button";

export function SessionActionsMenu(props: {
	isPinned: boolean;
	onNewChat: () => void;
	onPin?: () => void;
	onRenameChat?: () => void;
	onRenameSession?: () => void;
	onRenameBranch?: () => void;
	onThreads: () => void;
	onChanges: () => void;
	onFiles: () => void;
	onAttempts?: () => void;
	onCheckpoints?: () => void;
	onTerminal?: () => void;
	onOpenOnDesktop?: () => void;
	onMergeBack?: () => void;
	onArchive: () => void;
}) {
	const { message } = useMessages(["chat"]);
	return (
		<View className="flex-row gap-1">
			{props.onAttempts === undefined ? null : (
				<Button variant="ghost" className="h-7" onPress={props.onAttempts}>
					{message("chat:attempts_title")}
				</Button>
			)}
			{props.onCheckpoints === undefined ? null : (
				<Button variant="ghost" className="h-7" onPress={props.onCheckpoints}>
					{message("chat:checkpoints_title")}
				</Button>
			)}
		</View>
	);
}
