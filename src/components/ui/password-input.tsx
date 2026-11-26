"use client";

import { forwardRef, useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input, type InputProps } from "./input";

export interface PasswordInputProps extends Omit<InputProps, "type" | "trailing"> {
  /**
   * `current-password` (sign-in, the default) or `new-password` (register,
   * reset). Password managers key their fill/save offers on this, so every
   * caller states it rather than inheriting a guess.
   */
  autoComplete?: "current-password" | "new-password";
}

/**
 * OPE-1548 — a password field with an optional show/hide toggle.
 *
 * Every password field in the main app goes through this component, so the
 * toggle behaves the same on /login, /register and the reset form.
 *
 * - Hidden is the default on every mount; the choice is component state only,
 *   never persisted, so a reload is always hidden again.
 * - The toggle is a real `<button type="button">` — it can never submit the
 *   form, and Enter in the field still submits as before.
 * - Accessible name is the constant "Show password" with `aria-pressed`
 *   carrying the state, so a screen reader reads "Show password, toggle
 *   button, (not) pressed". A label that ALSO flips to "Hide password" would
 *   announce "Hide password, pressed" — a double negative — so the label stays
 *   fixed and the icon changes for sighted users.
 * - Tapping the eye keeps focus in the field: `pointerdown` is prevented so the
 *   input never blurs. Because it is still the focused element when React
 *   commits the `type` swap, React's own commit-phase selection restore
 *   (getSelectionInformation / restoreSelection) puts focus and the caret back
 *   if the engine resets them. Keyboard activation (Tab to the button,
 *   Space/Enter) leaves focus on the button, where the user put it.
 * - Edge/IE draw their own reveal eye on password inputs; `::-ms-reveal` is
 *   hidden so there are never two.
 */
const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, id, autoComplete = "current-password", disabled, ...props }, forwardedRef) => {
    const generatedId = useId();
    const inputId = id || props.name || generatedId;
    const [visible, setVisible] = useState(false);
    const toggle = () => setVisible((v) => !v);

    return (
      <Input
        {...props}
        id={inputId}
        ref={forwardedRef}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        className={cn("pr-12 [&::-ms-reveal]:hidden [&::-ms-clear]:hidden", className)}
        trailing={
          <button
            type="button"
            aria-label="Show password"
            aria-pressed={visible}
            aria-controls={inputId}
            disabled={disabled}
            onPointerDown={(e) => e.preventDefault()}
            onClick={toggle}
            className={cn(
              "absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg",
              "text-muted-foreground hover:text-foreground",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {visible ? (
              <EyeOff className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Eye className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
        }
      />
    );
  }
);

PasswordInput.displayName = "PasswordInput";

export { PasswordInput };
