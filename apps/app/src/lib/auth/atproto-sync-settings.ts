import { z } from "zod";

/**
 * Atmosphere subscription sync settings, shared by the connection row, the
 * settings procedure, the consent-upgrade state, and the Atmosphere pane.
 * The four-way method the user picks is presentation over two stored
 * booleans (import and export); "bidirectional" is both, "none" neither.
 * No env access: the pane imports this too.
 */

export const ATPROTO_SYNC_METHODS = [
  "none",
  "import",
  "export",
  "bidirectional",
] as const;

export type AtprotoSyncMethod = (typeof ATPROTO_SYNC_METHODS)[number];

export const atprotoSyncMethodSchema = z.enum(ATPROTO_SYNC_METHODS);

/** The stored shape: what the connection row carries. */
export const atprotoSyncSettingsSchema = z.object({
  importSubscriptions: z.boolean(),
  exportSubscriptions: z.boolean(),
  importAsInactive: z.boolean(),
});

export type AtprotoSyncSettings = z.infer<typeof atprotoSyncSettingsSchema>;

/** The presented shape: what the pane edits and saves. */
export const atprotoSyncPreferencesSchema = z.object({
  method: atprotoSyncMethodSchema,
  importAsInactive: z.boolean(),
});

export type AtprotoSyncPreferences = z.infer<
  typeof atprotoSyncPreferencesSchema
>;

/** The None default every sign-up and link starts from. */
export const DEFAULT_ATPROTO_SYNC_SETTINGS: AtprotoSyncSettings = {
  importSubscriptions: false,
  exportSubscriptions: false,
  importAsInactive: false,
};

export const ATPROTO_SYNC_METHOD_LABELS: Record<AtprotoSyncMethod, string> = {
  none: "None",
  import: "Atmosphere → Serial",
  export: "Serial → Atmosphere",
  bidirectional: "Bidirectional",
};

export function syncMethodFromSettings(
  settings: Pick<
    AtprotoSyncSettings,
    "importSubscriptions" | "exportSubscriptions"
  >,
): AtprotoSyncMethod {
  if (settings.importSubscriptions && settings.exportSubscriptions) {
    return "bidirectional";
  }
  if (settings.importSubscriptions) return "import";
  if (settings.exportSubscriptions) return "export";
  return "none";
}

export function syncSettingsFromPreferences(
  preferences: AtprotoSyncPreferences,
): AtprotoSyncSettings {
  return {
    importSubscriptions:
      preferences.method === "import" || preferences.method === "bidirectional",
    exportSubscriptions:
      preferences.method === "export" || preferences.method === "bidirectional",
    importAsInactive: preferences.importAsInactive,
  };
}

export function syncPreferencesFromSettings(
  settings: AtprotoSyncSettings,
): AtprotoSyncPreferences {
  return {
    method: syncMethodFromSettings(settings),
    importAsInactive: settings.importAsInactive,
  };
}

/**
 * Whether a method writes to the user's repository and therefore needs the
 * social permission set on the connection's grant.
 */
export function syncMethodNeedsWriteScope(method: AtprotoSyncMethod): boolean {
  return method === "export" || method === "bidirectional";
}
