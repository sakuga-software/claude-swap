/**
 * The "cswap-dark" and "cswap-light" themes, the shared colors, and the
 * layout values of the Python `cswap.tcss` stylesheet.
 *
 * The accent is the warm terracotta (xterm 173) of the CLI printer. The
 * severity colors are desaturated so that the usage bars stay calm.
 */

export const ACCENT = "#d7875f";
export const FOREGROUND = "#e8e4de";
export const MUTED = "#8a8a8a";
export const BACKGROUND = "#141414";
export const SURFACE = "#1e1e1e";
export const PANEL = "#262626";

export const SEV_OK = "#87af87";
export const SEV_WARN = "#d7af5f";
export const SEV_CRIT = "#d75f5f";
export const TRACK = "#3a3a3a";

// CRIT is the default auto-switch threshold, so the bar color and the switch behavior agree.
export const WARN_PCT = 70.0;
export const CRIT_PCT = 90.0;

/** The design tokens of one theme, with the keys of a Textual `Theme`. */
export interface Theme {
  readonly name: string;
  readonly primary: string;
  readonly secondary: string;
  readonly accent: string;
  readonly foreground: string;
  readonly background: string;
  readonly surface: string;
  readonly panel: string;
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  readonly dark: boolean;
  readonly variables: Readonly<Record<string, string>>;
}

/** The resolved colors that the render functions bake into their styles. */
export class Palette {
  static DARK: Palette;

  constructor(
    readonly accent: string,
    readonly foreground: string,
    readonly muted: string,
    readonly sevOk: string,
    readonly sevWarn: string,
    readonly sevCrit: string,
    readonly track: string,
  ) {
    Object.freeze(this);
  }

  severity(pct: number | null | undefined): string {
    if (pct === null || pct === undefined) return this.muted;
    if (pct >= CRIT_PCT) return this.sevCrit;
    if (pct >= WARN_PCT) return this.sevWarn;
    return this.sevOk;
  }

  static fromTheme(theme: Theme): Palette {
    return new Palette(
      theme.primary,
      theme.foreground,
      theme.secondary,
      theme.success,
      theme.warning,
      theme.error,
      theme.variables.track ?? TRACK,
    );
  }
}

export const CSWAP_DARK: Theme = Object.freeze({
  name: "cswap-dark",
  primary: ACCENT,
  secondary: MUTED,
  accent: ACCENT,
  foreground: FOREGROUND,
  background: BACKGROUND,
  surface: SURFACE,
  panel: PANEL,
  success: SEV_OK,
  warning: SEV_WARN,
  error: SEV_CRIT,
  dark: true,
  variables: Object.freeze({
    "footer-key-foreground": ACCENT,
    "block-cursor-background": PANEL,
    "block-cursor-foreground": FOREGROUND,
    track: TRACK,
  }),
});

// The light colors are deepened so that text keeps a 4.5:1 contrast on the panel color too.
export const ACCENT_LIGHT = "#954c2a";
export const FOREGROUND_LIGHT = "#2b2723";
export const MUTED_LIGHT = "#635d55";
export const BACKGROUND_LIGHT = "#faf7f2";
export const SURFACE_LIGHT = "#efeae1";
export const PANEL_LIGHT = "#e2dbcf";
export const SEV_OK_LIGHT = "#3d6b3d";
export const SEV_WARN_LIGHT = "#795911";
export const SEV_CRIT_LIGHT = "#ad3128";
export const TRACK_LIGHT = "#cec7ba";

export const CSWAP_LIGHT: Theme = Object.freeze({
  name: "cswap-light",
  primary: ACCENT_LIGHT,
  secondary: MUTED_LIGHT,
  accent: ACCENT_LIGHT,
  foreground: FOREGROUND_LIGHT,
  background: BACKGROUND_LIGHT,
  surface: SURFACE_LIGHT,
  panel: PANEL_LIGHT,
  success: SEV_OK_LIGHT,
  warning: SEV_WARN_LIGHT,
  error: SEV_CRIT_LIGHT,
  dark: false,
  variables: Object.freeze({
    "footer-key-foreground": ACCENT_LIGHT,
    "block-cursor-background": PANEL_LIGHT,
    "block-cursor-foreground": FOREGROUND_LIGHT,
    track: TRACK_LIGHT,
  }),
});

Palette.DARK = new Palette(ACCENT, FOREGROUND, MUTED, SEV_OK, SEV_WARN, SEV_CRIT, TRACK);

export const THEMES: Readonly<Record<string, Theme>> = Object.freeze({
  [CSWAP_DARK.name]: CSWAP_DARK,
  [CSWAP_LIGHT.name]: CSWAP_LIGHT,
});

/** The spacing of `cswap.tcss`, as Ink box properties (padding is `[vertical, horizontal]`). */
export const LAYOUT = Object.freeze({
  accountsPanel: { paddingY: 1, paddingX: 3 },
  autoActivePanel: { paddingTop: 1, paddingX: 3 },
  menuTitle: { marginTop: 1, paddingX: 3 },
  list: { paddingTop: 1, paddingLeft: 1, paddingRight: 2 },
  listItem: { paddingX: 1, markerWidth: 1 },
  listTitle: { marginTop: 1, paddingX: 3 },
  autoTop: { paddingY: 1, paddingX: 2 },
  modal: { width: 64, wideWidth: 90, paddingY: 1, paddingX: 2, maxOutputLines: 20 },
  /** The default display time of a notification, in seconds. */
  notifyTimeoutS: 5,
});
