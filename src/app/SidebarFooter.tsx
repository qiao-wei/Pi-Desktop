/**
 * 侧栏底部工具条：语言切换 / 明暗主题 / 设置.
 *
 * 语言切换本来在标题栏右格（挨着右侧面板开关），2026-10-29 用户要求挪到左下角、
 * 明暗切换的左边。单独成文件有两个原因：`Sidebar.tsx` 被 max-lines 棘轮冻着，
 * 而且这三个按钮共用同一套 i18n 与图标依赖，留在一起比散在侧栏 JSX 里好读。
 */
import { setLocale } from "../i18n/index.ts";
import { useLocale, useT } from "../i18n/react";
import { Button } from "@/components/ui/button";
import { Moon, Settings, Sun } from "lucide-react";

function SidebarFooter({
  theme,
  onToggleTheme,
  onOpenSettings,
}: {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onOpenSettings: () => void;
}) {
  const t = useT();
  const locale = useLocale();

  return (
    <footer className="flex flex-none justify-end gap-1 border-t border-border/70 px-3.5 pt-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))]">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
        aria-label={locale === "zh" ? t("titlebar.switchToEnglish") : t("titlebar.switchToChinese")}
        aria-pressed={locale === "en"}
        title={locale === "zh" ? t("titlebar.switchToEnglish") : t("titlebar.switchToChinese")}
      >
        <span className="text-[11px] font-bold tracking-wide">{locale === "zh" ? "EN" : "中"}</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onToggleTheme}
        aria-label={theme === "dark" ? t("titlebar.toLightTheme") : t("titlebar.toDarkTheme")}
        title={theme === "dark" ? t("titlebar.toLightTheme") : t("titlebar.toDarkTheme")}
      >
        {theme === "dark" ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" onClick={onOpenSettings} aria-label={t("common.openSettings")} title={t("common.openSettings")}>
        <Settings className="size-[18px]" />
      </Button>
    </footer>
  );
}

export { SidebarFooter };