import { FormEvent, useState } from "react";
import { login } from "../api";
import { useUi } from "../state";
import { LANGS, Lang } from "../i18n";

export function Login({ onDone }: { onDone: () => void }) {
  const { t, lang, setLang } = useUi();
  const [f, setF] = useState({ tenant: "demo-a", email: "", password: "" });
  const [err, setErr] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try { await login(f.tenant, f.email, f.password); onDone(); } catch { setErr(true); }
  };
  return (
    <div className="center">
      <form className="card" onSubmit={submit}>
        <h1>{t("login")}</h1>
        <label>{t("factory")}<input value={f.tenant} onChange={(e) => setF({ ...f, tenant: e.target.value })} /></label>
        <label>{t("email")}<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label>{t("password")}<input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        {err && <p className="err">{t("wrongLogin")}</p>}
        <button type="submit">{t("signIn")}</button>
        <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>{LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</select>
      </form>
    </div>
  );
}
