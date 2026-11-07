import { describe, expect, it } from "vitest";
import {
  syncMethodFromSettings,
  syncMethodNeedsWriteScope,
  syncPreferencesFromSettings,
  syncSettingsFromPreferences,
} from "~/lib/auth/atproto-sync-settings";

/**
 * The four-way method is presentation over two stored booleans; the two
 * mappings must round-trip and agree on which methods write to the PDS.
 */
describe("atproto sync settings", () => {
  it.each([
    [{ importSubscriptions: false, exportSubscriptions: false }, "none"],
    [{ importSubscriptions: true, exportSubscriptions: false }, "import"],
    [{ importSubscriptions: false, exportSubscriptions: true }, "export"],
    [{ importSubscriptions: true, exportSubscriptions: true }, "bidirectional"],
  ] as const)("presents %o as %s", (settings, method) => {
    expect(syncMethodFromSettings(settings)).toBe(method);
    expect(
      syncSettingsFromPreferences({ method, importAsInactive: true }),
    ).toEqual({ ...settings, importAsInactive: true });
  });

  it("round-trips the stored shape through the presented shape", () => {
    const stored = {
      importSubscriptions: true,
      exportSubscriptions: false,
      importAsInactive: true,
    };
    expect(
      syncSettingsFromPreferences(syncPreferencesFromSettings(stored)),
    ).toEqual(stored);
  });

  it("only the exporting methods need write scope", () => {
    expect(syncMethodNeedsWriteScope("none")).toBe(false);
    expect(syncMethodNeedsWriteScope("import")).toBe(false);
    expect(syncMethodNeedsWriteScope("export")).toBe(true);
    expect(syncMethodNeedsWriteScope("bidirectional")).toBe(true);
  });
});
