/**
 * 面板拖拽手柄.
 *
 * 从 `src/app/App.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */
import { cn } from "@/lib/utils";
import type { PointerEvent as ReactPointerEvent } from "react";

function PanelResizeHandle({
  side,
  divider = false,
  resizing = false,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onDoubleClick,
}: {
  side: "left" | "right";
  /** 该边界是否需要常显分隔线（右侧面板与聊天列同底色时用）。 */
  divider?: boolean;
  /** 是否正在拖这个手柄（:hover 在 pointer capture 期间可能失效）。 */
  resizing?: boolean;
  onPointerDown: (side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}) {
  return (
    <div
      className={cn(
        "panel-resize-handle relative z-[5] min-h-0 min-w-0 cursor-col-resize touch-none bg-transparent outline-none max-[920px]:hidden",
      )}
      data-divider={divider ? "true" : undefined}
      data-resizing={resizing ? "true" : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side === "left" ? "projects" : "context"} panel`}
      tabIndex={0}
      onPointerDown={(event) => onPointerDown(side, event)}
      onPointerMove={(event) => onPointerMove(side, event)}
      onPointerUp={(event) => onPointerUp(side, event)}
      onDoubleClick={onDoubleClick}
    />
  );
}

export { PanelResizeHandle };
