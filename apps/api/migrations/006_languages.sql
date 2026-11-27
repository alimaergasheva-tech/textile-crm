-- Языки интерфейса: добавляются английский и турецкий.
ALTER TABLE users DROP CONSTRAINT users_locale_check;
ALTER TABLE users ADD CONSTRAINT users_locale_check CHECK (locale IN ('ru','uz','en','tr'));
ALTER TABLE tenants DROP CONSTRAINT tenants_default_locale_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_default_locale_check CHECK (default_locale IN ('ru','uz','en','tr'));

ALTER TABLE reference_values ADD COLUMN name_en text, ADD COLUMN name_tr text;
ALTER TABLE colors ADD COLUMN name_en text, ADD COLUMN name_tr text;

-- Переводы стандартных значений
UPDATE reference_values r SET name_en = v.en, name_tr = v.tr
  FROM (VALUES
    ('lead_source','call','Phone call','Telefon görüşmesi'), ('lead_source','telegram','Telegram','Telegram'),
    ('lead_source','instagram','Instagram','Instagram'), ('lead_source','site','Website','Web sitesi'),
    ('lead_source','expo','Exhibition','Fuar'), ('lead_source','referral','Referral','Tavsiye'),
    ('loss_reason','price','Price','Fiyat'), ('loss_reason','terms','Lead time','Teslim süresi'),
    ('loss_reason','quality','Quality','Kalite'), ('loss_reason','other','Other','Diğer'),
    ('defect_reason','seam','Seam defect','Dikiş hatası'), ('defect_reason','fabric','Fabric defect','Kumaş hatası'),
    ('defect_reason','size','Wrong size','Yanlış beden')) AS v(d,c,en,tr)
 WHERE r.dictionary = v.d AND r.code = v.c;
UPDATE colors c SET name_en = v.en, name_tr = v.tr
  FROM (VALUES ('WHT','White','Beyaz'),('BLK','Black','Siyah'),('NVY','Navy','Lacivert'),('RED','Red','Kırmızı')) AS v(code,en,tr)
 WHERE c.code = v.code;
