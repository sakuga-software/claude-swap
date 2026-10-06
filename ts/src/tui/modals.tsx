/** Modal screens: confirmations, token entry and the display of captured output. */

import { Box, Text as InkText } from "ink";
import type { ReactNode } from "react";
import { LAYOUT, type Theme } from "./theme.js";
import { type RenderContext, Screen, binding } from "./widgets.js";

/** A modal screen. The app draws it over the screen below it. */
export abstract class ModalScreen<R> extends Screen<R> {
  readonly isModal = true;
  /** The button or field that has the focus. */
  focus = 0;

  abstract focusCount(): number;

  actionFocusNext(): void {
    this.focus = (this.focus + 1) % this.focusCount();
    this.app.changed();
  }

  actionFocusPrevious(): void {
    this.focus = (this.focus - 1 + this.focusCount()) % this.focusCount();
    this.app.changed();
  }
}

function ModalBox({
  ctx,
  title,
  wide = false,
  children,
}: {
  ctx: RenderContext;
  title: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const theme = ctx.theme;
  return (
    <Box
      flexDirection="column"
      width={Math.min(wide ? LAYOUT.modal.wideWidth : LAYOUT.modal.width, Math.floor(ctx.columns * 0.9))}
      backgroundColor={theme.surface}
      borderStyle="round"
      borderColor={theme.panel}
      paddingY={LAYOUT.modal.paddingY}
      paddingX={LAYOUT.modal.paddingX}
    >
      <Box marginBottom={1}>
        <InkText bold color={theme.primary}>
          {title}
        </InkText>
      </Box>
      {children}
    </Box>
  );
}

function Buttons({ theme, labels, focused }: { theme: Theme; labels: string[]; focused: number | null }) {
  return (
    <Box flexDirection="row" justifyContent="flex-end" marginTop={1}>
      {labels.map((label, i) => {
        const isFocused = i === focused;
        const pad = Math.max(0, 12 - label.length - 4);
        const left = Math.floor(pad / 2);
        return (
          <Box key={label} marginLeft={2} backgroundColor={isFocused ? theme.primary : theme.panel}>
            <InkText bold={isFocused} color={isFocused ? theme.background : theme.foreground}>
              {`  ${" ".repeat(left)}${label}${" ".repeat(pad - left)}  `}
            </InkText>
          </Box>
        );
      })}
    </Box>
  );
}

function Hint({ theme, text }: { theme: Theme; text: string }) {
  return (
    <Box marginTop={1}>
      <InkText color={theme.secondary} wrap="truncate-end">
        {text}
      </InkText>
    </Box>
  );
}

/**
 * A yes/no confirmation. It gives true only on an explicit confirm.
 * ← and → move between the buttons, Enter presses the focused one, y and n answer directly, Esc cancels.
 */
export class ConfirmModal extends ModalScreen<boolean> {
  readonly kind = "confirm";
  override bindings = [
    binding("y", "confirm", "Yes", { show: false }),
    binding("n,escape", "cancel", "No", { show: false }),
    binding("left", "focus_previous", "", { show: false }),
    binding("right", "focus_next", "", { show: false }),
  ];

  constructor(
    readonly message: string,
    readonly title = "Confirm",
    readonly yesLabel = "Yes",
  ) {
    super();
  }

  focusCount(): number {
    return 2;
  }

  override onKey(name: string): boolean {
    if (name !== "enter") return false;
    this.dismiss(this.focus === 0);
    return true;
  }

  actionConfirm(): void {
    this.dismiss(true);
  }

  actionCancel(): void {
    this.dismiss(false);
  }

  render(ctx: RenderContext): ReactNode {
    const theme = ctx.theme;
    return (
      <ModalBox ctx={ctx} title={this.title}>
        <Box marginBottom={1}>
          <InkText color={theme.foreground}>{this.message}</InkText>
        </Box>
        <Buttons theme={theme} labels={[this.yesLabel, "Cancel"]} focused={this.focus} />
        <Hint theme={theme} text={`← → · enter  ·  y ${this.yesLabel.toLowerCase()}  ·  n / esc cancel`} />
      </ModalBox>
    );
  }
}

/** What the add-token modal collects. */
export interface TokenForm {
  token: string;
  email: string | null;
  slot: number | null;
}

export type TokenField = "token" | "email" | "slot";

const TOKEN_FIELDS: readonly TokenField[] = ["token", "email", "slot"];

/** The text of an integer input after one typed string, or null if Textual refuses the character. */
export function integerInput(value: string, typed: string): string | null {
  const next = value + typed;
  return /^[-+]?\d*$/.test(next) ? next : null;
}

/** Validate the form fields. Returns the form, or the error message. */
export function parseTokenForm(values: Readonly<Record<TokenField, string>>): TokenForm | string {
  const token = values.token.trim();
  const email = values.email.trim() || null;
  const slotRaw = values.slot.trim();
  if (!token) return "Token is required.";
  let slot: number | null = null;
  if (slotRaw) {
    if (!/^[-+]?\d+$/.test(slotRaw)) return "Slot must be a number.";
    slot = Number.parseInt(slotRaw, 10);
    if (slot < 1) return "Slot must be >= 1.";
  }
  return { token, email, slot };
}

/**
 * Collects a setup-token or an API key, an optional email label and an optional slot.
 * ← and → move between the buttons only when a button has the focus.
 */
export class AddTokenModal extends ModalScreen<TokenForm | null> {
  readonly kind = "token";
  override bindings = [binding("escape", "cancel", "Cancel", { show: false })];
  values: Record<TokenField, string> = { token: "", email: "", slot: "" };
  error = "";

  focusCount(): number {
    return TOKEN_FIELDS.length + 2;
  }

  /** The focused input field, or null when a button has the focus. */
  get focusedField(): TokenField | null {
    return TOKEN_FIELDS[this.focus] ?? null;
  }

  override onKeyFirst(name: string, input: string): boolean {
    const field = this.focusedField;
    if (name === "tab") {
      this.actionFocusNext();
      return true;
    }
    if (name === "shift+tab") {
      this.actionFocusPrevious();
      return true;
    }
    if (field === null) return false;
    if (name === "enter") {
      this.submit();
      return true;
    }
    if (name === "backspace") {
      this.values[field] = this.values[field].slice(0, -1);
      this.app.changed();
      return true;
    }
    if (name === "left" || name === "right") return true;
    if (name !== "escape" && input && !input.startsWith("ctrl+") && name === input) {
      const typed = input.replace(/[\r\n]/g, "");
      const next = field === "slot" ? integerInput(this.values[field], typed) : this.values[field] + typed;
      if (next !== null) this.values[field] = next;
      this.app.changed();
      return true;
    }
    return false;
  }

  override onKey(name: string): boolean {
    if (name === "left") {
      this.actionFocusPrevious();
      return true;
    }
    if (name === "right") {
      this.actionFocusNext();
      return true;
    }
    if (name !== "enter") return false;
    if (this.focus === TOKEN_FIELDS.length + 1) this.dismiss(null);
    else this.submit();
    return true;
  }

  submit(): void {
    const form = parseTokenForm(this.values);
    if (typeof form === "string") {
      this.error = form;
      this.app.changed();
      return;
    }
    this.dismiss(form);
  }

  actionCancel(): void {
    this.dismiss(null);
  }

  render(ctx: RenderContext): ReactNode {
    const theme = ctx.theme;
    const placeholders: Record<TokenField, string> = {
      token: "token (required)",
      email: "email label (optional)",
      slot: "slot number (optional)",
    };
    return (
      <ModalBox ctx={ctx} title="Add account from token">
        <Box marginBottom={1}>
          <InkText color={theme.foreground}>
            OAuth setup-token (sk-ant-oat…) or managed API key (sk-ant-api…); the type is auto-detected.
          </InkText>
        </Box>
        {TOKEN_FIELDS.map((field, i) => {
          const value = field === "token" ? "•".repeat(this.values.token.length) : this.values[field];
          const focused = this.focus === i;
          return (
            <Box
              key={field}
              marginBottom={1}
              borderStyle="round"
              borderColor={focused ? theme.primary : theme.panel}
              backgroundColor={theme.background}
              paddingX={1}
            >
              <InkText color={value ? theme.foreground : theme.secondary} wrap="truncate-start">
                {value || placeholders[field]}
                {focused ? <InkText color={theme.primary}>▏</InkText> : ""}
              </InkText>
            </Box>
          );
        })}
        <InkText color={theme.error}>{this.error || " "}</InkText>
        <Buttons
          theme={theme}
          labels={["Add", "Cancel"]}
          focused={this.focus >= TOKEN_FIELDS.length ? this.focus - TOKEN_FIELDS.length : null}
        />
        <Hint theme={theme} text="enter add  ·  tab next field  ·  esc cancel" />
      </ModalBox>
    );
  }
}

/** A scrollable display of captured action output (with ANSI colors). */
export class OutputModal extends ModalScreen<null> {
  readonly kind = "output";
  override bindings = [binding("escape,q,enter", "dismiss_modal", "Close", { show: false })];
  scroll = 0;

  constructor(
    readonly title: string,
    readonly output: string,
  ) {
    super();
  }

  focusCount(): number {
    return 1;
  }

  get lines(): string[] {
    return (this.output.trimEnd() || "(no output)").split("\n");
  }

  override onKey(name: string): boolean {
    const maxScroll = Math.max(0, this.lines.length - LAYOUT.modal.maxOutputLines);
    if (name === "down" || name === "j") this.scroll = Math.min(maxScroll, this.scroll + 1);
    else if (name === "up" || name === "k") this.scroll = Math.max(0, this.scroll - 1);
    else return false;
    this.app.changed();
    return true;
  }

  actionDismissModal(): void {
    this.dismiss(null);
  }

  render(ctx: RenderContext): ReactNode {
    const theme = ctx.theme;
    const visible = this.lines.slice(this.scroll, this.scroll + LAYOUT.modal.maxOutputLines);
    return (
      <ModalBox ctx={ctx} title={this.title} wide>
        <Box flexDirection="column" backgroundColor={theme.background} padding={1}>
          {visible.map((line, i) => (
            <InkText key={i} color={theme.foreground}>
              {line || " "}
            </InkText>
          ))}
        </Box>
        <Buttons theme={theme} labels={["Close"]} focused={0} />
        <Hint theme={theme} text="esc close" />
      </ModalBox>
    );
  }
}
