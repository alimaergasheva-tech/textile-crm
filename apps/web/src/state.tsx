import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { Lang, LANGS, Currency, t as tr, Key } from "./i18n";

interface Ui { lang: Lang; setLang(l: Lang): void; theme: "light" | "dark"; toggleTheme(): void;
  currency: Currency; setCurrency(c: Currency): void; t(k: Key): string }
const Ctx = createContext<Ui>(null as never);
export const useUi = () => useContext(Ctx);

const read = <T,>(k: string, d: T): T => { try { return (localStorage.getItem(k) as T) ?? d; } catch { return d; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } };

export function UiProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => {
    const saved = read<string>("lang", "");
    if (LANGS.some((l) => l.code === saved)) return saved as Lang;
    const nav = navigator.language.slice(0, 2);          // первый заход: язык браузера, если он поддерживается
    return (LANGS.find((l) => l.code === nav)?.code ?? "ru") as Lang;
  });
  const [theme, setTheme] = useState<"light" | "dark">(read("theme", "light"));
  const [currency, setCurrency] = useState<Currency>(read("currency", "UZS"));
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.lang = lang; }, [theme, lang]);
  const value: Ui = {
    lang, theme, currency,
    setLang: (l) => { setLang(l); write("lang", l); },
    toggleTheme: () => { const n = theme === "light" ? "dark" : "light"; setTheme(n); write("theme", n); },
    setCurrency: (c) => { setCurrency(c); write("currency", c); },
    t: (k) => tr(lang, k),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export interface Me { id: string; tenantId: string; permissions: string[] }
const MeCtx = createContext<{ me: Me; can(code: string): boolean; signOut(): void }>(null as never);
export const useMe = () => useContext(MeCtx);
export const MeProvider = MeCtx.Provider;
