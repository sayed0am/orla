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
	IconChevronDown as TablerIconChevronDown,
	IconChevronLeft as TablerIconChevronLeft,
	IconChevronRight as TablerIconChevronRight,
	IconDeviceMobile as TablerIconDeviceMobile,
	IconFileExport as TablerIconFileExport,
	IconJson as TablerIconJson,
	IconLockSquareRounded as TablerIconLockSquareRounded,
	IconMarkdown as TablerIconMarkdown,
	IconMenu2 as TablerIconMenu,
	IconMoon as TablerIconMoon,
	IconSettings as TablerIconSettings,
	IconSunHigh as TablerIconSunHigh,
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
export const IconMenu = wrap(TablerIconMenu, "Threads");
export const IconChevronDown = wrap(TablerIconChevronDown, "Expand");
export const IconMoon = wrap(TablerIconMoon, "Dark");
export const IconSunHigh = wrap(TablerIconSunHigh, "Light");
export const IconDeviceMobile = wrap(TablerIconDeviceMobile, "System");
export const IconFileExport = wrap(TablerIconFileExport, "Export");
export const IconMarkdown = wrap(TablerIconMarkdown, "Markdown");
export const IconJson = wrap(TablerIconJson, "JSON");
export const IconLock = wrap(TablerIconLockSquareRounded, "Private");
