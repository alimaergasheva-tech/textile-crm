import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useUi } from "./state";
import { pickName } from "./i18n";

export interface DictItem { dictionary: string; code: string; name_ru: string; name_uz: string | null; name_en: string | null; name_tr: string | null }

/** Справочники CRM (источники лидов, причины проигрыша) с названием на текущем языке. */
export function useDicts() {
  const { lang } = useUi();
  const q = useQuery({ queryKey: ["dicts"], queryFn: () => api<DictItem[]>("/dictionaries") });
  const list = (d: string) => (q.data ?? []).filter((x) => x.dictionary === d)
    .map((x) => ({ code: x.code, name: pickName(lang, x) }));
  return { list, name: (d: string, code: string) => list(d).find((x) => x.code === code)?.name ?? code };
}
