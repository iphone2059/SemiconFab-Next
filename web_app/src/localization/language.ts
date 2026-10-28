/**
 * UI language preference shared by the locale store and the Twin feature.
 *
 * This is browser/display state, so it lives in the localized UI layer and not in
 * domain/**: domain modules must stay free of user-interface language state. Raw
 * reference data that carries localized columns declares its own pure data key.
 */
export type TwinLanguage = 'zh' | 'en';
