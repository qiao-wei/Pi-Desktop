import { useCallback, useEffect, useRef, useState } from "react";

import { fetchCustomModels } from "./customModelsApi";
import type { CustomModelsResponse } from "./customModelsApi";

/**
 * 自定义模型清单（`~/.pi/agent/models.json` 的视图）。
 *
 * 输入框旁的模型列表和设置页共用这一份：设置页保存/删除/设默认后把返回的 payload
 * 直接 `apply` 进来，输入框立刻能选到新模型，不用再发一次请求。
 * 拉取失败只影响「哪一行算自定义、哪一行是默认」这些装饰信息，模型列表本身还有 bootstrap 兜底。
 */
export function useCustomModels() {
  const [entries, setEntries] = useState<CustomModelsResponse["customModels"]>([]);
  const [modelsPath, setModelsPath] = useState("~/.pi/agent/models.json");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const apply = useCallback((response: CustomModelsResponse) => {
    if (!mountedRef.current) {
      return;
    }
    setEntries(response.customModels ?? []);
    setModelsPath(response.modelsPath || modelsPath);
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      apply(await fetchCustomModels());
    } catch (reloadError) {
      if (mountedRef.current) {
        setError(reloadError instanceof Error ? reloadError.message : String(reloadError));
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [apply]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { entries, modelsPath, loading, error, reload, apply };
}

export type CustomModelsController = ReturnType<typeof useCustomModels>;
