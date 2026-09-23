"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  shouldHoldDisclosure,
  type CollapseGateGeometry,
} from "@/shared/collapseGate";

/**
 * Read the geometry a collapse gate needs. Two rect reads plus three numbers.
 */
export function measureCollapseGeometry(
  root: HTMLElement,
  container: HTMLElement,
): CollapseGateGeometry {
  const block = root.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  return {
    blockTop: block.top,
    blockBottom: block.bottom,
    containerTop: box.top,
    containerBottom: box.bottom,
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
  };
}

/** Nearest scrollable ancestor, same rule as `useScrollPositionLock`. */
export function findScrollContainer(node: HTMLElement | null): HTMLElement | null {
  let container = node;
  while (container) {
    const { overflowY } = getComputedStyle(container);
    if (overflowY === "scroll" || overflowY === "auto") {
      return container;
    }
    container = container.parentElement;
  }
  return null;
}

/**
 * The geometry the gate judges, or `null` when there is nothing to judge:
 * unmounted, detached, or living outside any scroll container.
 *
 * Gates measure during render on purpose: at that moment `rootRef.current` still
 * describes the layout the reader is looking at - the collapsed DOM has not been
 * written yet. Measuring after the commit would read the *shrunken* box and
 * classify the collapse by where the block ended up rather than where it was.
 */
function geometryOf(root: HTMLElement | null): CollapseGateGeometry | null {
  const container = findScrollContainer(root);
  if (!root || !container) {
    return null;
  }
  return measureCollapseGeometry(root, container);
}

/**
 * Hold an auto-collapse until the disclosure is off screen.
 *
 * Takes the open state a component *wants* (running → open, settled → closed)
 * and returns the open state it should *render*. A true→false intent stays open
 * while releasing the height would be visible, and commits on the scroll that
 * carries the block out of view. Nothing is ever written to the scroll
 * container: the shift is not compensated, it is scheduled away, so this cannot
 * fight the thread viewport owner or a flick still being committed.
 *
 * Only ever use it on a disclosure that is **already mounted and open**. A block
 * that mounts with a closed intent cannot be "held" the same way: the panel has
 * no previous height to keep and its trigger row is new flow. So a component that
 * wants to be held at settle time has to exist before the settle - which is why the
 * 过程 group is created with the first process part of the turn and only flips
 * `open` when the turn ends, instead of re-wrapping the whole subtree in that one
 * commit. Keep that shape in mind when a new disclosure appears: if the collapse is
 * a *replacement* of DOM rather than a transition, no gate can see it and the reader
 * gets a jump.
 *
 * The second return value releases the gate for good. Call it from the manual
 * toggle handler - a reader who clicks the chevron has said what they want, and
 * a deferred auto-collapse must never overrule them.
 */
export function useDeferredCollapse(
  rootRef: RefObject<HTMLElement | null>,
  desiredOpen: boolean,
): [boolean, () => void] {
  const manualRef = useRef(false);
  const [held, setHeld] = useState(false);
  const decidedRef = useRef<boolean | null>(desiredOpen);

  if (decidedRef.current !== desiredOpen) {
    decidedRef.current = desiredOpen;
    const next = shouldHoldDisclosure({
      desiredOpen,
      manual: manualRef.current,
      geometry: geometryOf(rootRef.current),
    });
    if (next !== held) {
      // Render-phase update: the value lands in this same commit, so the DOM
      // never passes through the collapsed state that was decided against.
      setHeld(next);
    }
  }

  useLayoutEffect(() => {
    if (!held) {
      return undefined;
    }
    const root = rootRef.current;
    const container = findScrollContainer(root);
    if (!root || !container) {
      setHeld(false);
      return undefined;
    }
    let frame = 0;
    const check = () => {
      frame = 0;
      if (manualRef.current) {
        setHeld(false);
        return;
      }
      if (!shouldHoldDisclosure({ desiredOpen: false, geometry: geometryOf(root) })) {
        setHeld(false);
      }
    };
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(check);
      }
    };
    // Judge the layout this component just produced. Still the same task, so a
    // block that turns out to be safely off screen collapses before it paints.
    check();
    container.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      container.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [held, rootRef]);

  const releaseCollapseGate = useCallback(() => {
    manualRef.current = true;
    setHeld(false);
  }, []);

  return [desiredOpen || held, releaseCollapseGate];
}
