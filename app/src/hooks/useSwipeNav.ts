/**
 * Horizontal swipe-to-navigate gesture, attached to a single element via a ref callback (not
 * `document`, so it can be scoped to one screen's body). Uses passive touch listeners only and
 * never calls `preventDefault`, so vertical scrolling — and native horizontal scrolling inside
 * things like chat code blocks — is left completely alone.
 *
 * A swipe fires on touchend when the horizontal displacement is at least 50px and clearly
 * dominates the vertical one (|dx| > |dy| * 1.5). Finger moving left fires `onSwipeLeft`; right
 * fires `onSwipeRight`. Multi-touch gestures are abandoned. Starting a touch inside an element
 * that's actually horizontally scrollable (overflow-x auto/scroll with scrollWidth > clientWidth)
 * skips tracking entirely, so that content keeps its native swipe-to-scroll behavior.
 */

import { useCallback, useRef } from "react";

const MIN_DISTANCE = 50;
const DIRECTION_RATIO = 1.5;

interface TouchState {
	startX: number;
	startY: number;
	tracking: boolean;
}

function isHorizontallyScrollable(el: Element): boolean {
	const style = window.getComputedStyle(el);
	const overflowX = style.overflowX;
	return (overflowX === "auto" || overflowX === "scroll") && el.scrollWidth > el.clientWidth;
}

function hasScrollableAncestor(target: EventTarget | null, boundary: HTMLElement): boolean {
	let node = target instanceof Element ? target : null;
	while (node) {
		if (isHorizontallyScrollable(node)) {
			return true;
		}
		if (node === boundary) {
			break;
		}
		node = node.parentElement;
	}
	return false;
}

/**
 * Returns a ref callback: attach it to the element that should act as the swipe surface. Listeners
 * are (re)installed whenever the element or `enabled` changes, and torn down on detach, on
 * `enabled` going false, or on unmount.
 */
export function useSwipeNav(
	enabled: boolean,
	onSwipeLeft: () => void,
	onSwipeRight: () => void,
): (el: HTMLElement | null) => void {
	const stateRef = useRef<TouchState | null>(null);
	const cleanupRef = useRef<(() => void) | null>(null);
	const onSwipeLeftRef = useRef(onSwipeLeft);
	const onSwipeRightRef = useRef(onSwipeRight);
	onSwipeLeftRef.current = onSwipeLeft;
	onSwipeRightRef.current = onSwipeRight;

	return useCallback(
		(el: HTMLElement | null) => {
			cleanupRef.current?.();
			cleanupRef.current = null;
			stateRef.current = null;

			if (!el || !enabled) {
				return;
			}
			const surface = el;

			function onTouchStart(event: TouchEvent) {
				if (event.touches.length !== 1) {
					stateRef.current = null;
					return;
				}
				if (hasScrollableAncestor(event.target, surface)) {
					stateRef.current = null;
					return;
				}
				const touch = event.touches[0];
				if (!touch) {
					stateRef.current = null;
					return;
				}
				stateRef.current = { startX: touch.clientX, startY: touch.clientY, tracking: true };
			}

			function onTouchMove(event: TouchEvent) {
				if (event.touches.length !== 1) {
					stateRef.current = null;
				}
			}

			function onTouchEnd(event: TouchEvent) {
				const state = stateRef.current;
				stateRef.current = null;
				if (!state?.tracking) {
					return;
				}
				const touch = event.changedTouches[0];
				if (!touch) {
					return;
				}
				const dx = touch.clientX - state.startX;
				const dy = touch.clientY - state.startY;
				if (Math.abs(dx) >= MIN_DISTANCE && Math.abs(dx) > Math.abs(dy) * DIRECTION_RATIO) {
					if (dx < 0) {
						onSwipeLeftRef.current();
					} else {
						onSwipeRightRef.current();
					}
				}
			}

			function onTouchCancel() {
				stateRef.current = null;
			}

			surface.addEventListener("touchstart", onTouchStart, { passive: true });
			surface.addEventListener("touchmove", onTouchMove, { passive: true });
			surface.addEventListener("touchend", onTouchEnd, { passive: true });
			surface.addEventListener("touchcancel", onTouchCancel, { passive: true });

			cleanupRef.current = () => {
				surface.removeEventListener("touchstart", onTouchStart);
				surface.removeEventListener("touchmove", onTouchMove);
				surface.removeEventListener("touchend", onTouchEnd);
				surface.removeEventListener("touchcancel", onTouchCancel);
			};
		},
		[enabled],
	);
}
