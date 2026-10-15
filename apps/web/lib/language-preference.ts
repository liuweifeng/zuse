import { detectLocale, parseLanguagePreferences } from "@zuse/i18n/detection";
import {
	isWebsiteLocale,
	type WebsiteLocale,
	websiteLocales,
} from "@zuse/i18n/registry";

export const LANGUAGE_COOKIE = "zuse-language";
export const LANGUAGE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function resolveWebsiteLanguage(
	preference: string | undefined,
	acceptLanguage: string | null,
	country: string | null,
): WebsiteLocale {
	if (preference && isWebsiteLocale(preference)) return preference;
	const detected = detectLocale(
		parseLanguagePreferences(acceptLanguage),
		websiteLocales,
		country,
	);
	return isWebsiteLocale(detected) ? detected : "en";
}

export function rememberWebsiteLanguage(locale: WebsiteLocale) {
	try {
		// biome-ignore lint/suspicious/noDocumentCookie: synchronous persistence must finish before navigation; supported by all target browsers.
		document.cookie = `${LANGUAGE_COOKIE}=${locale}; Path=/; Max-Age=${LANGUAGE_COOKIE_MAX_AGE}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
	} catch {}
}
