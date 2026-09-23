import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui/input";

/**
 * API key 输入框：已存的 key 由调用方回填进 value（默认密文），眼睛图标切明文/密文。
 *
 * 框里没字就是真没字 —— 不能拿一串假圆点当占位符，那会让人以为“点眼睛应该能看到东西”，
 * 然后判定图标坏了。所以 key 得是桥回传的真值（见 `GET /api/model-providers/:id` 的 apiKey）。
 */
export function ApiKeyField({
  id,
  value,
  onChange,
  placeholder,
  savedConfigured = false,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** 该 provider 已经存过 key：框留空表示继续用存的那份。 */
  savedConfigured?: boolean;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="min-w-0 flex-1">
      <div className="relative min-w-0">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          className="pr-10"
          value={value}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label={visible ? "Hide API key" : "Show API key"}
          aria-pressed={visible}
          title={visible ? "Hide" : "Show"}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
      {savedConfigured && !value.trim() ? (
        <p className="mt-1 text-xs text-muted-foreground">
          No key in the box: the saved one stays in use. Type a new one to replace it.
        </p>
      ) : null}
    </div>
  );
}
