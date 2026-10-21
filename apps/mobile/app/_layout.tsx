import "../global.css";
import "~/polyfills";

import { GeistMono_400Regular } from "@expo-google-fonts/geist-mono";
import { useFonts } from "expo-font";
import * as Linking from "expo-linking";
import { router, Stack, usePathname } from "expo-router";
import {
	DarkTheme,
	DefaultTheme,
	ThemeProvider,
} from "expo-router/react-navigation";
import * as ScreenOrientation from "expo-screen-orientation";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { Uniwind, useUniwind } from "uniwind";

import { CrashReportOverlay } from "~/components/crash-report-overlay";
import { TextPromptHost } from "~/components/text-prompt-host";
import { useMobileAnalytics } from "~/hooks/use-mobile-analytics";
import { noteMobileInteraction } from "~/lib/analytics";
import { installCrashReporting } from "~/lib/crash-reporting";
import { isTabletDevice, useReadableContentStyle } from "~/lib/form-factor";
import { SHEET_PRESENTATION, TRANSPARENT_HEADER } from "~/lib/native-header";
import { isLegacyPairingUrl } from "~/lib/pairing";
import { installNotificationResponseHandler } from "~/notifications/push";
import { usePushRegistration } from "~/notifications/use-push-registration";
import { useCloudRuntimeLifecycle } from "~/store/cloud-runtime-lifecycle";
import { useLocalConnectivityRuntime } from "~/store/local-connectivity-runtime";
import { AppAtomProvider } from "~/store/registry";
import { colors } from "~/theme";

Uniwind.setTheme("system");

function ConnectivityRuntimeBridge() {
	useLocalConnectivityRuntime();
	useCloudRuntimeLifecycle();
	usePushRegistration();
	const pathname = usePathname();
	useMobileAnalytics(pathname);
	useEffect(() => {
		// Tablets keep the system's rotation; only phones pin portrait.
		if (isTabletDevice()) return;
		void ScreenOrientation.lockAsync(
			pathname.endsWith("/terminal")
				? ScreenOrientation.OrientationLock.ALL
				: ScreenOrientation.OrientationLock.PORTRAIT_UP,
		).catch(() => undefined);
	}, [pathname]);
	return null;
}

export default function RootLayout() {
	const { theme } = useUniwind();
	const isDark = theme === "dark";
	const [fontsLoaded] = useFonts({
		GeistMono_400Regular,
	});
	const incomingUrl = Linking.useURL();
	// Wide windows center content in a readable column; headers stay full width.
	const readableContent = useReadableContentStyle();

	useEffect(() => {
		installCrashReporting();
		return installNotificationResponseHandler();
	}, []);

	useEffect(() => {
		if (incomingUrl !== null && isLegacyPairingUrl(incomingUrl)) {
			router.replace({
				pathname: "/connect/pair",
				params: { pairing: incomingUrl },
			});
		}
	}, [incomingUrl]);

	if (!fontsLoaded) {
		return <View className="flex-1 bg-background" />;
	}

	// iOS form sheets show system glass through a clear background.
	const sheetBackground = Platform.OS === "ios" ? "transparent" : colors.bg;
	const fullBleedContent = { backgroundColor: colors.bg };

	return (
		<AppAtomProvider>
			<GestureHandlerRootView
				style={{ flex: 1 }}
				onTouchStart={noteMobileInteraction}
			>
				<KeyboardProvider statusBarTranslucent>
					<ConnectivityRuntimeBridge />
					<ThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
						<StatusBar style="auto" />
						<Stack
							screenOptions={{
								headerLargeTitle: true,
								headerTransparent: TRANSPARENT_HEADER,
								headerShadowVisible: false,
								headerLargeTitleShadowVisible: false,
								headerStyle:
									Platform.OS === "ios"
										? { backgroundColor: "transparent" }
										: { backgroundColor: colors.bg },
								scrollEdgeEffects:
									Platform.OS === "ios"
										? {
												top: "automatic",
												bottom: "hidden",
												left: "hidden",
												right: "hidden",
											}
										: undefined,
								headerLargeTitleStyle: { color: colors.fg },
								headerTitleStyle: { color: colors.fg },
								headerTintColor: colors.fg,
								headerBackButtonDisplayMode: "minimal",
								contentStyle: readableContent,
							}}
						>
							<Stack.Screen name="index" options={{ title: "Chats" }} />
							<Stack.Screen
								name="onboarding"
								options={{
									headerShown: false,
									presentation: "fullScreenModal",
									gestureEnabled: false,
								}}
							/>
							<Stack.Screen
								name="new-chat"
								options={{
									title: "New Chat",
									headerLargeTitle: false,
									presentation: "card",
								}}
							/>
							<Stack.Screen
								name="settings"
								options={{
									title: "Settings",
									headerShown: false,
									presentation: SHEET_PRESENTATION,
									headerLargeTitle: false,
									sheetAllowedDetents: [0.92],
									sheetInitialDetentIndex: 0,
									sheetGrabberVisible: true,
									headerTintColor: colors.fg,
									headerTransparent: TRANSPARENT_HEADER,
									// The nested settings stack applies the readable column.
									contentStyle: fullBleedContent,
								}}
							/>
							<Stack.Screen
								name="archives"
								options={{ title: "Archived chats", headerLargeTitle: false }}
							/>
							<Stack.Screen
								name="usage"
								options={{ title: "Usage", headerLargeTitle: false }}
							/>
							<Stack.Screen
								name="developer-tools"
								options={{ title: "Developer tools", headerLargeTitle: false }}
							/>
							<Stack.Screen
								name="plan-viewer"
								options={{
									title: "Plan",
									presentation: "modal",
									headerLargeTitle: false,
								}}
							/>
							<Stack.Screen
								name="media-viewer"
								options={{
									contentStyle: fullBleedContent,
									headerShown: false,
									presentation: "fullScreenModal",
									animation: "fade",
								}}
							/>
							<Stack.Screen
								name="connect/nearby"
								options={{
									title: "Nearby Macs",
									headerLargeTitle: false,
									presentation: "card",
								}}
							/>
							<Stack.Screen
								name="connect/manual"
								options={{
									title: "Add connection",
									presentation: "card",
									headerLargeTitle: false,
									headerTransparent: false,
								}}
							/>
							<Stack.Screen
								name="connect/scan"
								options={{
									contentStyle: fullBleedContent,
									title: "Scan",
									headerLargeTitle: false,
									headerShown: false,
									presentation: "fullScreenModal",
								}}
							/>
							<Stack.Screen
								name="connect/pair"
								options={{
									title: "Pair with desktop",
									headerLargeTitle: false,
									presentation: "card",
								}}
							/>
							<Stack.Screen
								name="c/[conn]/index"
								options={{ title: "Sessions" }}
							/>
							<Stack.Screen
								name="c/[conn]/session/[sessionId]"
								options={{ title: "Thread", headerLargeTitle: false }}
							/>
							<Stack.Screen
								name="c/[conn]/chat/[chatId]/threads"
								options={{
									title: "Threads",
									headerLargeTitle: false,
									presentation: SHEET_PRESENTATION,
									sheetAllowedDetents: [0.42, 0.92],
									sheetInitialDetentIndex: 0,
									sheetGrabberVisible: true,
									contentStyle: {
										...readableContent,
										backgroundColor: sheetBackground,
									},
								}}
							/>
							<Stack.Screen
								name="c/[conn]/session/[sessionId]/files"
								options={{
									title: "Files",
									headerLargeTitle: false,
									presentation: "card",
								}}
							/>
							<Stack.Screen
								name="c/[conn]/session/[sessionId]/file"
								options={{
									title: "File",
									headerLargeTitle: false,
									presentation: "card",
								}}
							/>
							<Stack.Screen
								name="c/[conn]/session/[sessionId]/terminal"
								options={{
									title: "Terminal",
									headerLargeTitle: false,
									headerTransparent: false,
									gestureEnabled: false,
									contentStyle: { backgroundColor: "#000000" },
								}}
							/>
							<Stack.Screen
								name="c/[conn]/session/[sessionId]/review"
								options={{
									title: "Review changes",
									headerLargeTitle: false,
									presentation: SHEET_PRESENTATION,
									sheetAllowedDetents: [0.72, 1],
									sheetInitialDetentIndex: 0,
									sheetGrabberVisible: true,
									contentStyle: {
										...readableContent,
										backgroundColor: sheetBackground,
									},
								}}
							/>
							<Stack.Screen
								name="c/[conn]/session/[sessionId]/resolve-conflict"
								options={{
									title: "Resolve conflict",
									headerLargeTitle: false,
									presentation: "card",
								}}
							/>
							<Stack.Screen
								name="c/[conn]/session/[sessionId]/tool/[itemId]"
								options={{
									title: "Tool details",
									headerLargeTitle: false,
									presentation: "modal",
								}}
							/>
							<Stack.Screen
								name="smoke"
								options={{ title: "Smoke", headerLargeTitle: false }}
							/>
						</Stack>
						<CrashReportOverlay />
						{Platform.OS === "ios" ? null : <TextPromptHost />}
					</ThemeProvider>
				</KeyboardProvider>
			</GestureHandlerRootView>
		</AppAtomProvider>
	);
}
