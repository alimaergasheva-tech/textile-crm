export type Lang = "ru" | "uz";
const D = {
  ru: { defectPhoto: "Фото брака", tasks: "Задания", qc: "ОТК", pay: "Зарплата", done: "Сделано", left: "осталось", queue: "в очереди", sent: "Отправлено", offline: "Нет связи — отметки сохранены и уйдут сами",
    empty: "Заданий нет", accept: "Принять", good: "Годные", defect: "Брак", month: "За месяц", pieces: "шт.", login: "Войти", email: "Почта", password: "Пароль", factory: "Фабрика",
    notLinked: "Аккаунт не привязан. Откройте ссылку-приглашение от руководителя.", all: "всё", error: "Ошибка", deadline: "Срок", devLogin: "Вход для проверки (вне Telegram)",
    deals: "Сделки", stock: "Склад", newLead: "Новый лид", name: "Имя", phone: "Телефон", source: "Источник", save: "Сохранить", quotes: "КП", markSent: "Отправлено", search: "Поиск",
    scan: "Скан", code: "Код / штрихкод", qty: "Количество", location: "Ячейка", receipt: "Приход", issue: "Расход", reserved: "в резерве", available: "доступно", notFound: "Код не найден", saved: "Сохранено", open: "Открытые сделки", pickCode: "Сначала отсканируйте или введите код",
    catalog: "Каталог", myOrders: "Заказы", cart: "Корзина", sendOrder: "Отправить заявку", repeat: "Повторить", cancelOrder: "Отменить", total: "Итого", items: "шт.", noStock: "под заказ",
    st_draft: "Заявка", st_pending_approval: "На согласовании", st_confirmed: "Подтверждён", st_in_production: "В производстве", st_ready: "Готов", st_shipped: "Отгружен", st_cancelled: "Отменён",
    rate: "Оцените заказ", complaint: "Рекламация", reason: "Причина", describe: "Опишите проблему", send: "Отправить", thanks: "Спасибо!", shipments: "Отгрузки", asClient: "Я клиент", sent2: "Заявка отправлена", notePh: "Комментарий к заявке",
    contractors: "Подрядчики", sendCut: "Передать крой", brought: "Привезли", planWord: "План", sentWord: "Передано", atContractor: "У подрядчика", pendingQc: "Ждут приёмки", acceptedWord: "Принято" },
  uz: { defectPhoto: "Brak surati", tasks: "Topshiriqlar", qc: "TKK", pay: "Maosh", done: "Bajarildi", left: "qoldi", queue: "navbatda", sent: "Yuborildi", offline: "Aloqa yo‘q — belgilar saqlandi, o‘zi yuboriladi",
    empty: "Topshiriq yo‘q", accept: "Qabul qilish", good: "Yaroqli", defect: "Brak", month: "Oy uchun", pieces: "dona", login: "Kirish", email: "Pochta", password: "Parol", factory: "Fabrika",
    notLinked: "Akkaunt ulanmagan. Rahbardan taklif havolasini oching.", all: "hammasi", error: "Xato", deadline: "Muddat", devLogin: "Tekshiruv uchun kirish (Telegramdan tashqari)",
    deals: "Bitimlar", stock: "Ombor", newLead: "Yangi lid", name: "Ism", phone: "Telefon", source: "Manba", save: "Saqlash", quotes: "Takliflar", markSent: "Yuborildi", search: "Qidiruv",
    scan: "Skan", code: "Kod / shtrixkod", qty: "Miqdor", location: "Katak", receipt: "Kirim", issue: "Chiqim", reserved: "rezervda", available: "mavjud", notFound: "Kod topilmadi", saved: "Saqlandi", open: "Ochiq bitimlar", pickCode: "Avval kodni skanerlang yoki kiriting",
    catalog: "Katalog", myOrders: "Buyurtmalar", cart: "Savat", sendOrder: "Ariza yuborish", repeat: "Takrorlash", cancelOrder: "Bekor qilish", total: "Jami", items: "dona", noStock: "buyurtma bo‘yicha",
    st_draft: "Ariza", st_pending_approval: "Kelishilmoqda", st_confirmed: "Tasdiqlandi", st_in_production: "Ishlab chiqarishda", st_ready: "Tayyor", st_shipped: "Jo‘natildi", st_cancelled: "Bekor qilindi",
    rate: "Buyurtmani baholang", complaint: "Reklamatsiya", reason: "Sabab", describe: "Muammoni yozing", send: "Yuborish", thanks: "Rahmat!", shipments: "Jo‘natmalar", asClient: "Men mijozman", sent2: "Ariza yuborildi", notePh: "Arizaga izoh",
    contractors: "Pudratchilar", sendCut: "Bichuvni topshirish", brought: "Olib kelishdi", planWord: "Reja", sentWord: "Topshirilgan", atContractor: "Pudratchida", pendingQc: "Qabul kutilmoqda", acceptedWord: "Qabul qilingan" },
};
export type Key = keyof (typeof D)["ru"];
export const tr = (l: Lang, k: Key) => D[l][k];
