import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

type Props = {
  className?: string;
  children: ReactNode;
  /** Called on every scroll of the inner box (the sidebar uses it to dismiss hover cards). */
  onScroll?: () => void;
  /**
   * 内容溢出时常驻滚动条，不跟滚动淡入淡出。
   *
   * 给「一打开就要看得出下面还有东西」的浮层用（包命令面板）：macOS 的原生 overlay 滚动条
   * 不滚动就不画，用户看到一列整齐截断的命令会以为列表到此为止（2026-09-22 实测反馈）。
   * 默认的自动隐藏是为侧栏那种「用户知道要滚」的长列表准备的，别改。
   */
  thumbAlwaysVisible?: boolean;
};

/**
 * Scroll container with a macOS-style overlay thumb, ported from codex-ui's
 * `AutoHideScroll` (there named the same).
 *
 * Why not `::-webkit-scrollbar`: Chrome does not repaint a class-toggled custom
 * scrollbar reliably (computed style changes, pixels stay put), and a custom
 * `::-webkit-scrollbar` forces a classic gutter that shifts the row width. So the
 * native bar is hidden entirely and the thumb is an absolutely positioned div that
 * fades in while scrolling / dragging and out ~700ms after it stops.
 */
export function AutoHideScroll({ className = "", children, onScroll, thumbAlwaysVisible = false }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef(0);
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;

  const paint = useCallback(() => {
    const box = boxRef.current;
    const thumb = thumbRef.current;
    if (!box || !thumb) {
      return;
    }

    const travel = box.scrollHeight - box.clientHeight;
    if (travel <= 0) {
      thumb.style.visibility = "hidden";
      return;
    }

    thumb.style.visibility = "";
    const height = Math.max(28, Math.round((box.clientHeight * box.clientHeight) / box.scrollHeight));
    const top = Math.round((box.scrollTop / travel) * (box.clientHeight - height));
    thumb.style.height = `${height}px`;
    thumb.style.transform = `translateY(${top}px)`;
  }, []);

  const show = useCallback(() => {
    const thumb = thumbRef.current;
    if (!thumb) {
      return;
    }

    paint();
    thumb.classList.add("is-visible");
    if (thumbAlwaysVisible) {
      return;
    }
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(
      () => !thumb.matches(":active") && thumb.classList.remove("is-visible"),
      700,
    );
  }, [paint, thumbAlwaysVisible]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) {
      return;
    }

    const handleScroll = () => {
      show();
      onScrollRef.current?.();
    };
    box.addEventListener("scroll", handleScroll, { passive: true });

    const observer = new ResizeObserver(() => {
      paint();
      const thumb = thumbRef.current;
      if (!thumb) {
        return;
      }
      const overflowing = box.scrollHeight - box.clientHeight > 0;
      if (thumbAlwaysVisible) {
        // 常驻模式：溢出就一直画着，不再等用户先滚一下才现身。
        thumb.classList.toggle("is-visible", overflowing);
      } else if (!overflowing) {
        thumb.classList.remove("is-visible");
      }
    });
    observer.observe(box);

    if (thumbAlwaysVisible) {
      show();
    }

    return () => {
      box.removeEventListener("scroll", handleScroll);
      observer.disconnect();
      window.clearTimeout(timerRef.current);
    };
  }, [paint, show, thumbAlwaysVisible]);

  function handleThumbPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const box = boxRef.current;
    const thumb = thumbRef.current;
    if (!box || !thumb) {
      return;
    }

    event.preventDefault();
    const travel = box.scrollHeight - box.clientHeight;
    const thumbTravel = Math.max(1, box.clientHeight - thumb.offsetHeight);
    const startY = event.clientY;
    const startTop = box.scrollTop;

    const move = (moveEvent: PointerEvent) => {
      box.scrollTop = Math.max(
        0,
        Math.min(travel, ((startTop + moveEvent.clientY - startY) / thumbTravel) * travel),
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      show();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <div className={`autohide-scroll ${className}`.trim()}>
      <div className="autohide-box" ref={boxRef}>
        {children}
      </div>
      <div className="autohide-thumb" ref={thumbRef} onPointerDown={handleThumbPointerDown} />
    </div>
  );
}