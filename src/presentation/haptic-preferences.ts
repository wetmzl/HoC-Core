/** Device feedback preferences stay local: saves can move between unlike hardware. */
export interface HapticPreferences { readonly enabled: boolean; readonly output: boolean }
export const HAPTIC_PREFERENCES_KEY = "hoc:haptic-preferences:v1";
const defaults: HapticPreferences = { enabled: true, output: true };
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export class HapticPreferencesStore {
  private value: HapticPreferences;
  constructor(private readonly storage?: PreferenceStorage) {
    let raw: unknown;
    try { raw = JSON.parse(storage?.getItem(HAPTIC_PREFERENCES_KEY) ?? "null"); } catch { /* Use defaults for unavailable or corrupt storage. */ }
    const saved = raw && typeof raw === "object" ? raw as Partial<HapticPreferences> : {};
    this.value = { enabled: typeof saved.enabled === "boolean" ? saved.enabled : defaults.enabled,
      output: typeof saved.output === "boolean" ? saved.output : defaults.output };
  }
  get(): HapticPreferences { return { ...this.value }; }
  /** Always applies this session; returns whether the device also persisted it. */
  update(update: Partial<HapticPreferences>): boolean {
    this.value = { ...this.value, ...update };
    try {
      if (!this.storage) return false;
      this.storage.setItem(HAPTIC_PREFERENCES_KEY, JSON.stringify(this.value));
      return true;
    } catch { return false; }
  }
}

function deviceStorage(): PreferenceStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
export const hapticPreferences = new HapticPreferencesStore(deviceStorage());
