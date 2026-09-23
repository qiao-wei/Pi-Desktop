import { useState } from "react";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  canUseSystemNotifications,
  ensureSystemNotificationPermission,
  systemNotificationChannel,
} from "../../lib/systemNotification";
import { loadUiPreferences, saveUiPreferences } from "../../lib/ui-preferences";
import { useT } from "../../i18n/react";

/**
 * 设置 → 通知。
 *
 * 开关直接读写 `ui-preferences`（与 CustomModelsSettings 的折叠状态同一套），不需要父组件
 * 持有副本：真正发送时 `usePiDesktopApp` 也是现读这份偏好，两处不会各自记一份状态。
 *
 * 默认关闭。系统通知是打断性的，而且 macOS 首次发送会弹权限询问 —— 那个询问应该由用户
 * 在设置页点开开关时触发，而不是某天后台跑完一轮任务时突然冒出来。
 */
export function NotificationSettings() {
  const t = useT();
  const supported = canUseSystemNotifications();
  const [enabled, setEnabled] = useState(() => loadUiPreferences().notifyOnTurnComplete === true);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setError(null);

    if (!next) {
      setEnabled(false);
      saveUiPreferences({ notifyOnTurnComplete: false });
      return;
    }

    // 纯 Web 的权限请求必须发生在用户手势里：放在这里（点击调用栈内）而不是发送路径上，
    // 否则窗口失焦时那次静默请求只会拿到 `default`，看起来像“开了但没用”。
    if (systemNotificationChannel() === "browser" && !(await ensureSystemNotificationPermission())) {
      setEnabled(false);
      saveUiPreferences({ notifyOnTurnComplete: false });
      setError(t("notification.settings.permissionDenied"));
      return;
    }

    setEnabled(true);
    saveUiPreferences({ notifyOnTurnComplete: true });
  }

  return (
    <div className="grid max-w-2xl gap-3">
      <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2.5">
        <div className="grid min-w-0 gap-0.5">
          <Label htmlFor="settings-notify-turn" className="text-sm font-medium">
            {t("notification.settings.label")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("notification.settings.desc")}</p>
        </div>
        <Switch
          id="settings-notify-turn"
          size="sm"
          checked={enabled}
          disabled={!supported}
          onCheckedChange={(next) => void toggle(next)}
          aria-label={t("notification.settings.label")}
        />
      </div>
      {supported ? null : (
        <p className="text-xs text-muted-foreground">{t("notification.settings.unsupported")}</p>
      )}
      {error ? (
        <p className="text-xs text-destructive" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}