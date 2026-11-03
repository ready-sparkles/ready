const MISSING_PAGE_CONTROL = "The Outlook page is missing a required control.";

export type TextControl = {
  textContent: string;
};

/** The part of a DOM click event the Outlook pages use. */
type ClickEvent = {
  preventDefault: () => void;
};

export type ClickControl = TextControl & {
  /** @external DOM element visibility */
  hidden: boolean;
  /** @external DOM element disabled state */
  disabled: boolean;
  href: string;
  addEventListener: (...args: readonly [string, (event: ClickEvent) => void | Promise<void>]) => void;
};

export type LinkControl = TextControl & {
  /** @external DOM element visibility */
  hidden: boolean;
  href: string;
};

const isTextControl = (value: unknown): value is TextControl => typeof value === "object" && value !== null;

const isClickControl = (value: unknown): value is ClickControl =>
  isTextControl(value) && "addEventListener" in value && typeof value.addEventListener === "function";

const isLinkControl = (value: unknown): value is LinkControl => isTextControl(value);

export const readTextControl = (selector: string): TextControl => {
  const value: unknown = document.querySelector(selector);
  if (!isTextControl(value)) {
    throw new Error(MISSING_PAGE_CONTROL);
  }

  return value;
};

export const readClickControl = (selector: string): ClickControl => {
  const value: unknown = document.querySelector(selector);
  if (!isClickControl(value)) {
    throw new Error(MISSING_PAGE_CONTROL);
  }

  return value;
};

export const readLinkControl = (selector: string): LinkControl => {
  const value: unknown = document.querySelector(selector);
  if (!isLinkControl(value)) {
    throw new Error(MISSING_PAGE_CONTROL);
  }

  return value;
};
