// Tip — a small tooltip for controls in the Beads tab.
//
// What: wraps one control and shows a short line of text when the pointer
// rests on it or the keyboard focuses it.
//
// Why: most of the tab's controls are icon-only (grip, chevrons, play, close,
// refresh), and an icon alone does not say what it does (bead-bb-b5o).
//
// Design notes:
// - Built on @radix-ui/react-tooltip, which BB provides at run time (it is
//   never bundled), so it positions and dismisses like BB's own tooltips.
// - Each Tip carries its own Provider. That costs nothing visible and means a
//   Tip works wherever it is dropped, with no provider to remember to mount
//   at the top of the tab.
//
// Gotchas:
// - The text is drawn in a portal, outside the plugin's part of the page.
//   The plugin's styles only apply inside elements marked as belonging to
//   it, so the portal's content must carry `usePortalScopeProps()`; without
//   them the tooltip appears unstyled.
// - The wrapped control must accept a ref and extra props (a DOM element, or
//   a component built with forwardRef), because the trigger is attached to
//   it directly instead of adding a wrapper element around it.
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement } from "react";

import { usePortalScopeProps } from "../../lib/portal-scope";

/**
 * Shows `label` as a tooltip for `children`.
 *
 * @param label Short plain-language description of what the control does.
 * @param children Exactly one control (see the file header for what it must
 *   accept).
 */
export function Tip({
  label,
  children,
}: {
  label: string;
  children: ReactElement;
}) {
  const scopeProps = usePortalScopeProps();
  return (
    <TooltipPrimitive.Provider delayDuration={400}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            {...scopeProps}
            sideOffset={4}
            className="z-[70] max-w-64 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-md"
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
