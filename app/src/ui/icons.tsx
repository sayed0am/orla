/** Thin wrappers around @tabler/icons-react so call sites keep their existing `Icon*` names,
 * decorative sizing (24px default, 22px in the tab bar), stroke weight, and aria-hidden default. */

import type { Icon, IconProps } from "@tabler/icons-react";
import {
	IconArrowUp,
	IconBook2,
	IconMessageCircle,
	IconSquareRoundedPlus,
	IconSunrise,
	IconX,
	IconChevronLeft as TablerIconChevronLeft,
	IconChevronRight as TablerIconChevronRight,
	IconSettings as TablerIconSettings,
} from "@tabler/icons-react";

function wrap(Base: Icon, title: string): Icon {
	function WrappedIcon(props: IconProps) {
		return <Base size={24} stroke={1.8} aria-hidden focusable={false} title={title} {...props} />;
	}
	WrappedIcon.displayName = `Icon(${title})`;
	return WrappedIcon;
}

export const IconCapture = wrap(IconSquareRoundedPlus, "Capture");
export const IconChat = wrap(IconMessageCircle, "Chat");
export const IconBrief = wrap(IconSunrise, "Brief");
export const IconJournal = wrap(IconBook2, "Journal");
export const IconSettings = wrap(TablerIconSettings, "Settings");
export const IconSend = wrap(IconArrowUp, "Send");
export const IconClose = wrap(IconX, "Close");
export const IconChevronLeft = wrap(TablerIconChevronLeft, "Previous");
export const IconChevronRight = wrap(TablerIconChevronRight, "Next");
