import { useEffect, useRef, useState, type ChangeEvent, type CompositionEvent } from "react";

/**
 * 输入法（IME）友好的受控输入。
 *
 * 中文/日文输入法在「组字」期间会不断把拼音字母写进 input：如果每次 `change` 都往
 * 上抛，搜索会在拼音阶段就跑一遍（`nihao` 搜不到东西、还会闪），拼音一变一搜。
 * 这里在 `compositionstart..compositionend` 之间只更新本地草稿，等选词落定
 * （`compositionend`）才把最终文本提交给搜索。
 *
 * 返回的 `isComposing()` 供 keydown 使用：组字中按 Enter/Esc 是在跟输入法交互
 * （确认候选 / 取消组字），不该触发「下一个匹配」或关闭搜索条。
 */
export function useImeSafeInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);

  // 外部（打开 / 关闭 / 重置）改了值就同步到草稿；组字中不覆盖，否则输入法候选会被吞。
  useEffect(() => {
    if (!composingRef.current) {
      setDraft(value);
    }
  }, [value]);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.value;
    setDraft(next);
    if (!composingRef.current) {
      onCommit(next);
    }
  }

  function handleCompositionStart() {
    composingRef.current = true;
  }

  function handleCompositionEnd(event: CompositionEvent<HTMLInputElement>) {
    composingRef.current = false;
    const next = event.currentTarget.value;
    setDraft(next);
    onCommit(next);
  }

  return {
    value: draft,
    onChange: handleChange,
    onCompositionStart: handleCompositionStart,
    onCompositionEnd: handleCompositionEnd,
    isComposing: () => composingRef.current,
  };
}