import "react";

declare module "react" {
  /** Allow CSS custom properties (`--name`) in inline style objects. */
  interface CSSProperties {
    [customProperty: `--${string}`]: string | number | undefined;
  }
}
