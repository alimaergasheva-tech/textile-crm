import { test } from "node:test";
import assert from "node:assert/strict";
import { signInitData, verifyInitData } from "../src/miniapp/telegram.ts";

const TOKEN = "123456:TEST-TOKEN";
const user = JSON.stringify({ id: 777, first_name: "Бригадир" });
const fresh = () => String(Math.floor(Date.now() / 1000));

test("подлинные данные Telegram принимаются", () => {
  const d = signInitData({ auth_date: fresh(), user, start_param: "demo-a_abc" }, TOKEN);
  const r = verifyInitData(d, TOKEN);
  assert.equal(r.user.id, 777);
  assert.equal(r.startParam, "demo-a_abc");
});
test("подделанные данные отклоняются", () => {
  const d = signInitData({ auth_date: fresh(), user }, TOKEN).replace("777", "778");
  assert.throws(() => verifyInitData(d, TOKEN));
  assert.throws(() => verifyInitData(signInitData({ auth_date: fresh(), user }, "другой:токен"), TOKEN));
});
test("устаревшие данные (старше суток) отклоняются", () => {
  const old = String(Math.floor(Date.now() / 1000) - 90000);
  assert.throws(() => verifyInitData(signInitData({ auth_date: old, user }, TOKEN), TOKEN));
});
test("без токена бота вход закрыт", () => {
  assert.throws(() => verifyInitData(signInitData({ auth_date: fresh(), user }, TOKEN), ""));
});
