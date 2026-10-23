/**
 * 斜杠菜单.
 *
 * 从 `src/app/CapabilitySurfaces.tsx` 搬出来的自包含一簇（只依赖 import 进来的东西，不碰模块状态）——
 * 大文件被 `max-lines` 棘轮冻着不许再长，所以按「一簇一文件」往外搬，调用点零改动。
 */
import type { SlashMenuItem } from "../features/chat/slashMenu";
import { t } from "../i18n/index.ts";
import { useT } from "../i18n/react";
import { Fragment, useEffect, useRef } from "react";
import type { ReactNode } from "react";

function SlashMenu({
  items,
  highlightIndex,
  onSelect,
  onHighlight,
}: {
  items: SlashMenuItem[];
  highlightIndex: number;
  onSelect: (item: SlashMenuItem) => void;
  onHighlight: (index: number) => void;
}) {
  const t = useT();
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    itemRefs.current[highlightIndex]?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex, items]);

  const entries = items.map((item, index) => ({ item, index }));
  const builtins = entries.filter((entry) => entry.item.kind === "builtin");
  const skills = entries.filter((entry) => entry.item.kind === "skill");
  const commands = entries.filter((entry) => entry.item.kind === "command");
  const argumentEntries = entries.filter((entry) => entry.item.kind === "argument");

  const renderRow = ({ item, index }: { item: SlashMenuItem; index: number }) => (
    <button
      key={slashMenuItemKey(item)}
      ref={(node) => {
        itemRefs.current[index] = node;
      }}
      type="button"
      role="option"
      aria-selected={index === highlightIndex}
      onClick={() => onSelect(item)}
      onMouseEnter={() => onHighlight(index)}
      className={`capability-picker-row ${index === highlightIndex ? "is-active" : ""}`}
    >
      <span className={`capability-dot ${item.kind === "skill" ? "skill" : "command"}`}>
        {item.kind === "skill" ? "S" : item.kind === "argument" ? "→" : "/"}
      </span>
      <span className="slash-menu-row-text">
        <strong>{item.kind === "argument" ? item.label : item.name}</strong>
        {item.description ? <small>{item.description}</small> : null}
      </span>
      {item.kind === "command" ? <small className="slash-menu-package">{item.packageName}</small> : null}
      {item.kind === "builtin" ? <small className="slash-menu-package">{t("capability.slashMenu.builtinTag")}</small> : null}
    </button>
  );

  const renderSection = (labelKey: string, list: Array<{ item: SlashMenuItem; index: number }>) => (
    list.length ? (
      <div className="slash-menu-section">
        <p className="slash-menu-section-label">{t(labelKey, { count: list.length })}</p>
        {list.map(renderRow)}
      </div>
    ) : null
  );

  // 分组顺序由 items 决定（buildSlashMenuItems 已把含最佳匹配的分组排前面），
  // 这里按各 kind 首次出现的顺序渲染，以后再加分组也不用改 JSX。
  const groupOrder: SlashMenuItem["kind"][] = [];
  for (const item of items) {
    if (!groupOrder.includes(item.kind)) {
      groupOrder.push(item.kind);
    }
  }
  const sections: Record<SlashMenuItem["kind"], ReactNode> = {
    argument: renderSection("capability.slashMenu.arguments", argumentEntries),
    builtin: renderSection("capability.slashMenu.builtins", builtins),
    command: renderSection("capability.slashMenu.commands", commands),
    skill: renderSection("capability.slashMenu.skills", skills),
  };

  return (
    <div className="capability-picker slash-menu" role="listbox" aria-label={t("capability.slashMenu.aria")}>
      {groupOrder.map((kind) => <Fragment key={kind}>{sections[kind]}</Fragment>)}
      {!items.length ? <p className="empty-text">{t("capability.slashMenu.empty")}</p> : null}
      {commands.length || builtins.length ? <p className="slash-menu-hint">{t("capability.slashMenu.commandHint")}</p> : null}
      {argumentEntries.length ? <p className="slash-menu-hint">{t("capability.slashMenu.argumentHint")}</p> : null}
    </div>
  );
}

function slashMenuItemKey(item: SlashMenuItem) {
  if (item.kind === "skill") {
    return `skill:${item.id}`;
  }
  if (item.kind === "argument") {
    return `argument:${item.value}`;
  }
  if (item.kind === "builtin") {
    return `builtin:${item.name}`;
  }
  return `command:${item.packageId}:${item.name}`;
}

export { SlashMenu, slashMenuItemKey };
