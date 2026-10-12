import { forwardRefIfNeeded } from "@hexclave/shared/dist/utils/react";
import React from "react";

import { cn } from "./utils";

type InputOTPContextValue = {
  value: string,
  maxLength: number,
  disabled?: boolean,
  setValue: (value: string) => void,
  selectionStart: number,
  selectionEnd: number,
};

const InputOTPContext = React.createContext<InputOTPContextValue | null>(null);

function useInputOTPContext() {
  const context = React.useContext(InputOTPContext);
  if (context == null) {
    throw new Error("InputOTPSlot must be rendered inside InputOTP");
  }
  return context;
}

type InputOTPProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "maxLength" | "value"> & {
  value: string,
  onChange: (value: string) => void,
  maxLength: number,
  containerClassName?: string,
  children: React.ReactNode,
};

const InputOTP = forwardRefIfNeeded<HTMLInputElement, InputOTPProps>(
  ({ className, containerClassName, children, value, onChange, maxLength, disabled, ...props }, ref) => {
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const pendingCaretRef = React.useRef<number | null>(null);

    // React rewrites the whole value of a controlled input on every keystroke, which parks the
    // caret at the end. Put it back where the edit happened, or typing into the middle of a code
    // jumps to the end after the first character. useLayoutEffect so it never paints in between.
    React.useLayoutEffect(() => {
      const input = inputRef.current;
      const pendingCaret = pendingCaretRef.current;
      pendingCaretRef.current = null;
      if (input == null || pendingCaret == null || document.activeElement !== input) {
        return;
      }
      const caret = Math.min(pendingCaret, input.value.length);
      if (input.selectionStart !== caret || input.selectionEnd !== caret) {
        input.setSelectionRange(caret, caret);
      }
    }, [value]);

    const [selection, setSelection] = React.useState({ start: 0, end: 0 });

    // The caret moves for reasons React never sees (arrow keys, Home/End, clicking, shift-select),
    // so mirror the input's real selection into state and let the slots render from it.
    React.useEffect(() => {
      const syncSelection = () => {
        const input = inputRef.current;
        if (input == null) {
          return;
        }
        setSelection({
          start: input.selectionStart ?? input.value.length,
          end: input.selectionEnd ?? input.value.length,
        });
      };

      syncSelection();
      document.addEventListener("selectionchange", syncSelection);
      return () => document.removeEventListener("selectionchange", syncSelection);
    }, [value]);

    const contextValue = React.useMemo<InputOTPContextValue>(() => ({
      value,
      maxLength,
      disabled,
      setValue: onChange,
      selectionStart: selection.start,
      selectionEnd: selection.end,
    }), [disabled, maxLength, onChange, selection.end, selection.start, value]);

    // The real input is visually hidden, so there is nothing obvious to aim at. Capture typing and
    // pasting from anywhere on the page and route it into the input, so a user coming back from
    // their email client can just start typing (or hit cmd+V) without hunting for the field.
    React.useEffect(() => {
      if (disabled) {
        return;
      }

      const isForeignEditable = (target: EventTarget | null) => {
        if (!(target instanceof HTMLElement) || target === inputRef.current) {
          return false;
        }
        return target.isContentEditable
          || target instanceof HTMLInputElement
          || target instanceof HTMLTextAreaElement
          || target instanceof HTMLSelectElement;
      };

      const onDocumentKeyDown = (event: KeyboardEvent) => {
        const input = inputRef.current;
        if (input == null || event.defaultPrevented) {
          return;
        }
        // Let shortcuts through, and ignore Space: it is never part of a code, and swallowing it
        // would stop it from activating whichever button currently has focus.
        if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1 || event.key === " ") {
          return;
        }
        if (document.activeElement === input || isForeignEditable(event.target)) {
          return;
        }
        event.preventDefault();
        input.focus();
        onChange((value + event.key).slice(0, maxLength));
      };

      const onDocumentPaste = (event: ClipboardEvent) => {
        const input = inputRef.current;
        if (input == null || event.defaultPrevented || isForeignEditable(event.target)) {
          return;
        }
        const pasted = (event.clipboardData?.getData("text") ?? "").replace(/\s/g, "");
        if (pasted === "") {
          return;
        }
        // A pasted code is always the whole code, so replace rather than append -- otherwise
        // pasting over a half-typed value silently produces a mangled code.
        event.preventDefault();
        input.focus();
        onChange(pasted.slice(0, maxLength));
      };

      document.addEventListener("keydown", onDocumentKeyDown);
      document.addEventListener("paste", onDocumentPaste);
      return () => {
        document.removeEventListener("keydown", onDocumentKeyDown);
        document.removeEventListener("paste", onDocumentPaste);
      };
    }, [disabled, maxLength, onChange, value]);

    return (
      <InputOTPContext.Provider value={contextValue}>
        <div
          className={cn("stack-scope relative flex items-center gap-2 has-[:disabled]:opacity-50", containerClassName)}
          onClick={() => inputRef.current?.focus()}
        >
          <input
            // `...props` must be spread FIRST: React 19 passes `ref` as a regular prop, so a
            // trailing spread would overwrite the callback ref below and leave `inputRef` null,
            // silently killing the click-to-focus handler above.
            {...props}
            ref={(node) => {
              inputRef.current = node;
              if (typeof ref === "function") {
                ref(node);
              } else if (ref != null) {
                ref.current = node;
              }
            }}
            value={value}
            maxLength={maxLength}
            disabled={disabled}
            className={cn("absolute inset-0 h-full w-full cursor-default opacity-0 disabled:cursor-not-allowed", className)}
            onChange={(event) => {
              pendingCaretRef.current = event.target.selectionStart;
              onChange(event.target.value.slice(0, maxLength));
            }}
          />
          {children}
        </div>
      </InputOTPContext.Provider>
    );
  },
);
InputOTP.displayName = "InputOTP";

const InputOTPGroup = forwardRefIfNeeded<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center gap-1", className)} {...props} />
  ),
);
InputOTPGroup.displayName = "InputOTPGroup";

const InputOTPSlot = forwardRefIfNeeded<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { index: number, size?: "default" | "lg" }>(
  ({ index, className, size = "default", ...props }, ref) => {
    const context = useInputOTPContext();
    const char = context.value.at(index) ?? "";
    const hasSelectionRange = context.selectionEnd > context.selectionStart;
    // Follow the real caret rather than assuming it sits after the last character: otherwise the
    // highlighted box lies about where the next keystroke or deletion will land.
    const isCaret = !hasSelectionRange && context.selectionStart === index && !context.disabled;
    const isSelected = hasSelectionRange && index >= context.selectionStart && index < context.selectionEnd && !context.disabled;
    const isActive = isCaret || isSelected;

    return (
      <div
        ref={ref}
        className={cn(
          // The slots are purely presentational and paint on top of the visually hidden input;
          // without `pointer-events-none` a click or tap on a box never reaches the input.
          "pointer-events-none relative flex h-9 w-9 items-center justify-center rounded-md border border-input text-sm",
          size === "lg" ? "h-10 w-10 text-lg font-medium" : "",
          isActive && "z-10 ring-1 ring-ring",
          className,
        )}
        {...props}
      >
        {char}
        {isCaret && char === "" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-4 w-px animate-caret-blink bg-foreground duration-1000" />
          </div>
        )}
      </div>
    );
  },
);
InputOTPSlot.displayName = "InputOTPSlot";

const InputOTPSeparator = forwardRefIfNeeded<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ ...props }, ref) => (
    <div ref={ref} role="separator" {...props}>
      -
    </div>
  ),
);
InputOTPSeparator.displayName = "InputOTPSeparator";

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator };
