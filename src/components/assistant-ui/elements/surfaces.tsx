"use client";

import type { ComponentProps } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";

export const field = "bg-foreground/[0.04] dark:bg-foreground/[0.06]";

export const collapsePanel =
  "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] data-[ending-style]:h-0 data-[starting-style]:h-0 motion-reduce:transition-none";

export const mono = "font-mono text-[11px] tracking-tight";

/**
 * Preserve the nearest chat viewport position while a disclosure changes
 * height. Unlike assistant-ui's generic scroll lock, this does not hide the
 * scrollbar or enable smooth restoration, so expanding a tool cannot produce
 * a visible viewport sweep.
 */
export function useScrollPositionLock<T extends HTMLElement = HTMLElement>(
  animatedElementRef: RefObject<T | null>,
  duration = 200,
) {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => cleanupRef.current?.();
  }, []);

  return useCallback(() => {
    cleanupRef.current?.();

    let scrollContainer: HTMLElement | null = animatedElementRef.current;
    while (scrollContainer) {
      const { overflowY } = getComputedStyle(scrollContainer);
      if (overflowY === "scroll" || overflowY === "auto") break;
      scrollContainer = scrollContainer.parentElement;
    }
    if (!scrollContainer) return;

    const scrollTop = scrollContainer.scrollTop;
    const previousScrollBehavior = scrollContainer.style.scrollBehavior;
    const previousOverflowAnchor = scrollContainer.style.overflowAnchor;
    const previousScrollTo = scrollContainer.scrollTo;
    const previousScrollBy = scrollContainer.scrollBy;
    let active = true;
    const wasAtBottom =
      Math.abs(
        scrollContainer.scrollHeight -
          scrollContainer.scrollTop -
          scrollContainer.clientHeight,
      ) <= 1;

    // assistant-ui's viewport observer follows the bottom whenever content
    // grows. During a disclosure animation that is not user intent: it would
    // move a tool that is currently in view to the newly-created document
    // bottom before the position lock gets a chance to restore it. Block
    // programmatic scroll requests only when the viewport was already at the
    // bottom; when the reader is above the bottom assistant-ui is already
    // following the user's position and needs no interception.
    if (wasAtBottom) {
      scrollContainer.scrollTo = (() =>
        undefined) as typeof scrollContainer.scrollTo;
      scrollContainer.scrollBy = (() =>
        undefined) as typeof scrollContainer.scrollBy;
      scrollContainer.style.overflowAnchor = "none";
    }
    scrollContainer.style.scrollBehavior = "auto";
    let frame = 0;
    const restorePosition = () => {
      if (!active) return;
      scrollContainer!.scrollTop = scrollTop;
      frame = requestAnimationFrame(restorePosition);
    };
    restorePosition();

    const finish = () => {
      active = false;
      cancelAnimationFrame(frame);
      scrollContainer!.scrollTop = scrollTop;
      if (wasAtBottom) {
        scrollContainer!.scrollTo = previousScrollTo;
        scrollContainer!.scrollBy = previousScrollBy;
      }
      scrollContainer!.style.scrollBehavior = previousScrollBehavior;
      if (wasAtBottom) {
        scrollContainer!.style.overflowAnchor = previousOverflowAnchor;
      }
      cleanupRef.current = null;
    };
    const timeoutId = window.setTimeout(finish, duration + 80);
    cleanupRef.current = () => {
      active = false;
      cancelAnimationFrame(frame);
      window.clearTimeout(timeoutId);
      scrollContainer!.scrollTop = scrollTop;
      if (wasAtBottom) {
        scrollContainer!.scrollTo = previousScrollTo;
        scrollContainer!.scrollBy = previousScrollBy;
      }
      scrollContainer!.style.scrollBehavior = previousScrollBehavior;
      if (wasAtBottom) {
        scrollContainer!.style.overflowAnchor = previousOverflowAnchor;
      }
      cleanupRef.current = null;
    };
  }, [animatedElementRef, duration]);
}

export function ShimmerLabel({
  active = true,
  className,
  ...props
}: ComponentProps<"span"> & { active?: boolean }) {
  return (
    <span
      className={cn(active && "shimmer motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

export function SwapLabel({
  active,
  children,
  className,
}: {
  active: 0 | 1;
  children: [React.ReactNode, React.ReactNode];
  className?: string;
}) {
  const layers = [useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null)];
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const target = layers[active]?.current;
    if (!target) return undefined;
    const measure = () =>
      setWidth(Math.ceil(target.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [active]);

  return (
    <span
      style={width === null ? undefined : { width }}
      className={cn(
        "grid overflow-x-clip transition-[width] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
        className,
      )}
    >
      {children.map((layer, index) => (
        <span
          key={index}
          ref={layers[index]}
          aria-hidden={active !== index}
          className={cn(
            "col-start-1 row-start-1 flex w-max items-center gap-1.5 leading-none transition-[opacity,filter] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
            active === index
              ? "opacity-100 blur-none"
              : "pointer-events-none select-none opacity-0 blur-[2px]",
          )}
        >
          {layer}
        </span>
      ))}
    </span>
  );
}
