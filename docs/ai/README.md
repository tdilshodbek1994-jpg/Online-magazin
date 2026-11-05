# UZSHOP PRO — AI BUSINESS ASSISTANT v1.0
Сана: 2026-11-05; Claude учун дастурлаш режаси ва шартнома/синов маълумотлари.
Бу код эмас ва жорий UzShop репозиторийсига ҳали уланмаган.
Асосий TXT: 38 бўлим; фойдаланувчининг роль, шахсий таҳлил ва тасдиқли амал талаблари сақланган.
contracts/metrics_catalog.json: 32 метрика, ҳар бири source/grain/date таърифи билан.
contracts/access_matrix.csv: 72 роль–ресурс сиёсати; default deny.
contracts/tool_registry.json: 22 read/draft tool шартномаси; executor LLMга берилмайди.
tests/acceptance_cases.json: 100 сценарий, ҳаммаси not_run.
tests/golden_examples.json: 18 synthetic мисол; ҳисоблаш натижалари ҳақиқий бизнес маълумоти эмас.
docs/DECISIONS_AND_SOURCES.md: қабул қилинган контекст, янги таклифлар ва расмий техник манбалар.
START_FOR_CLAUDE.txt: аудит ва P0дан бошлаш кўрсатмаси.
JSON/CSV parse ва эталон арифметика текшируви репозиторий, CI ёки production синовини алмаштирмайди.
Тест ҳолатларини actual CI натижасисиз passedга алмаштирманг.
Фақат Online-magazinда ишланади; TAQVIM маълумотлари ва калитлари қўшилмайди.
