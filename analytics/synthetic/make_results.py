"""
Собирает итоги в папку results/: страницу с цифрами (results/README.md),
графики и небольшие таблицы — то, что идёт на слайд и в отчёт.

Перед запуском нужны данные обеих частей:
    python community_events_synthetic.py
    cd ab_experiment && python generate.py && python pipeline.py && cd ..
    python make_results.py
"""
import shutil
import sys
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE / 'ab_experiment'))
import analysis  # noqa: E402
import generate  # noqa: E402
import pipeline  # noqa: E402

OUT = HERE / 'results'
OUT.mkdir(exist_ok=True)


def pct(v, d=1):
    return f'{v * 100:.{d}f}%'.replace('.', ',')


def pp(v):
    sign = '+' if v >= 0 else '−'
    return f'{sign}{abs(v) * 100:.1f}'.replace('.', ',') + ' п.п.'


def ci_pp(text):
    """'[+0.114; +0.150]' -> '+11,4 … +15,0 п.п.'"""
    lo, hi = (float(x) for x in text.strip('[]').split(';'))
    return f"{pp(lo)[:-5]} … {pp(hi)}"


def dec(v, d):
    return f'{v:.{d}f}'.replace('.', ',')


def num(v):
    return f'{int(round(v)):,}'.replace(',', ' ')


def md_table(header, rows):
    lines = ['| ' + ' | '.join(header) + ' |', '|' + '---|' * len(header)]
    lines += ['| ' + ' | '.join(str(c) for c in r) + ' |' for r in rows]
    return '\n'.join(lines)


# ===== эксперимент =====
cfg = generate.Config()
r = pipeline.run(save=False)
res = analysis.run(r['people'], r['weekly'])
m, s, pl, aa = res['main'], res['srm'], res['planning'], res['aa']
true = {k: cfg.p_call_join[('B', k)] - cfg.p_call_join[('A', k)] for k in ['guest', 'user', 'member']}

for name in ['funnel', 'segments', 'monitoring', 'aa', 'wecu']:
    shutil.copy(HERE / 'ab_experiment' / 'charts' / f'{name}.png', OUT / f'ab_{name}.png')

# Сводная таблица для слайда.
summary = pd.DataFrame([
    ['Conversion to Call Join (главная)', m['A'], m['B'], m['diff'], m['p_value'], 'значимо' if m['significant'] else 'нет'],
    *[[g['Метрика'], g['A'], g['B'], g['Разница B−A'], g['p-value'], g['Статус']] for _, g in res['guardrails'].iterrows()],
], columns=['Метрика', 'A', 'B', 'Разница B−A', 'p-value', 'Итог'])
summary.to_csv(OUT / 'ab_summary.csv', index=False)
res['segments'].to_csv(OUT / 'ab_segments.csv', index=False)
res['monitoring'].to_csv(OUT / 'ab_monitoring.csv', index=False)
r['funnel'].to_csv(OUT / 'ab_funnel.csv')

# ===== данные и метрики продукта (модуль синтетики) =====
mod = HERE / 'output'
for name in ['data_quality', 'funnel_ab', 'wecu_weekly', 'retention_heatmap']:
    shutil.copy(mod / f'{name}.png', OUT / f'data_{name}.png')
quality = pd.read_csv(mod / 'data_quality_report.csv')
cohorts = pd.read_csv(mod / 'gold_retention_cohorts.csv', index_col=0)
cac = pd.read_csv(mod / 'gold_cac_by_channel.csv', index_col=0)
wecu = pd.read_csv(mod / 'gold_wecu_weekly.csv', index_col=0)
bronze_n = sum(1 for _ in open(mod / 'bronze_events.csv', encoding='utf-8')) - 1
quarantine_n = sum(1 for _ in open(mod / 'quarantine_events.csv', encoding='utf-8')) - 1
for name in ['data_quality_report', 'gold_retention_cohorts', 'gold_cac_by_channel', 'gold_wecu_weekly']:
    shutil.copy(mod / f'{name}.csv', OUT / f'data_{name}.csv')

seg_rows = []
for (key, label), row in zip(analysis.SEGMENT_LABELS.items(), res['segments'].itertuples(index=False)):
    seg_rows.append([label, pp(true[key]), pp(row[5]), ci_pp(row[6]), 'да' if row[7] < analysis.ALPHA / 3 else 'нет'])

guard_rows = [[g['Метрика'], pct(g['A']), pct(g['B']), pp(g['Разница B−A']), g['Граница'], g['Статус']]
              for _, g in res['guardrails'].iterrows()]
mon_rows = [[x['Проверка'], num(x['Участников']), pct(x['A']), pct(x['B']), f"{x['z']:.2f}".replace('.', ','),
             f"{x['Граница |z|']:.2f}".replace('.', ','), x['Пересекли']] for _, x in res['monitoring'].iterrows()]
diag = res['diagnostics']

text = f"""# Итоги: A/B-тест «вход в звонок по ссылке без регистрации»

Результаты на синтетических данных. Числа получены запуском кода из этой папки (seed = 42) и воспроизводятся. Все вероятности в генераторе — допущения модели, а не измерения продукта: расчёт показывает, что метрики и дизайн эксперимента работают и находят заложенный эффект.

## Главное — для слайда

- **Conversion to Call Join: A {pct(m['A'])} → B {pct(m['B'])}, {pp(m['diff'])}** (95% ДИ {pp(m['ci_low'])} … {pp(m['ci_high'])}), относительный прирост **{pct(m['lift'])}**, p < 0,001.
- Эффект почти целиком у **гостей без аккаунта**: заложено +12 п.п., тест нашёл **{pp(res['segments'].iloc[0]['Разница'])}**
- **Защитные метрики в границах**, но в B немного хуже: активация {pp(res['guardrails'].iloc[0]['Разница B−A'])}, удержание D7 {pp(res['guardrails'].iloc[2]['Разница B−A'])}, ранний выход {pp(res['guardrails'].iloc[1]['Разница B−A'])} — всё в пределах заданных границ
- **Метод проверен**: группы поделились ровно (SRM p = {dec(s['p_value'], 2)}), A/A-тест даёт {pct(aa['false_positive_rate'])} ложных срабатываний при норме ≈5%.
- **Решение: {res['decision']}**

![Эффект по сегментам](ab_segments.png)

## Дизайн и планирование

- Рандомизация по пользователю 50/50 по хешу устройства, группа фиксируется при первом открытии ссылки.
- A — регистрация до звонка, B — вход в звонок по ссылке, регистрация после.
- Выборка: p₁ = {pct(pl['p1'])}, MDE = {pct(pl['mde'], 0)}, α = 0,05, мощность 80% → **{num(pl['n_per_group'])} на группу** ({num(pl['total'])} всего), **{pl['days']} дней** при ~{num(pl['opens_per_day'])} открытиях в день.
- Чувствительность: MDE 1 п.п. → {num(pl['n_for_mde'][0.01])} на группу, 2 п.п. → {num(pl['n_for_mde'][0.02])}, 5 п.п. → {num(pl['n_for_mde'][0.05])}.
- Фактически в тесте: A {num(s['n_A'])}, B {num(s['n_B'])} человек.

## Защитные метрики

{md_table(['Метрика', 'A', 'B', 'Разница', 'Граница', 'Итог'], guard_rows)}

## Сегменты (поправка Бонферрони, α = 0,05 / 3)

{md_table(['Сегмент', 'Заложено', 'Оценка', 'ДИ', 'Значимо'], seg_rows)}

## Воронка по шагам

| Шаг | A | B |
|---|---|---|
""" + '\n'.join(f'| {k} | {pct(v["A"])} | {pct(v["B"])} |' for k, v in diag.iterrows()) + f"""

График — воронка гостя без аккаунта (основной сегмент эффекта):

![Воронка гостя](ab_funnel.png)

## Последовательный мониторинг (О'Брайен–Флеминг)

{md_table(['Проверка', 'Участников', 'A', 'B', 'z', 'Граница', 'Пересекли'], mon_rows)}

Эффект виден уже на первой проверке, но по плану досрочно останавливаемся только при вреде — решение после 14 дней.

![Мониторинг](ab_monitoring.png)

## A/A-тест

Группу A 1000 раз случайно делили пополам: значимых различий {pct(aa['false_positive_rate'])} (норма ≈5%), p-value распределены равномерно (KS p = {dec(aa['ks_p_value'], 3)}).

![A/A-тест](ab_aa.png)

## Данные и метрики продукта

Модуль `community_events_synthetic.py` — отдельный прогон (другой объём и случайные числа), поэтому цифры воронки немного отличаются от эксперимента выше.

- **Качество данных:** из {num(bronze_n)} сырых событий в карантин ушло {num(quarantine_n)} ({pct(quarantine_n / bronze_n)}).

{md_table(['Проверка', 'Ошибок', 'Доля'], [[q.проверка, num(q.ошибок), pct(q.доля_ошибок, 2)] for q in quality.itertuples() if q.ошибок > 0])}

- **WECU по неделям:** {', '.join(num(v) for v in wecu['WECU'])} (пик {num(wecu['WECU'].max())}).
- **Когортное удержание** (доля активных по неделям после вступления):

{md_table(['Когорта'] + [f'Неделя {c}' for c in cohorts.columns], [[i] + [pct(v, 0) for v in row] for i, row in cohorts.iterrows()])}

- **CAC по каналам:**

{md_table(['Канал', 'Новых пользователей', 'Расходы, ₽', 'CAC, ₽'], [[i, num(row['новых_пользователей']), num(row['расходы']), f"{row['CAC']:.0f}"] for i, row in cac.iterrows()])}

![Качество данных](data_data_quality.png)
![WECU](data_wecu_weekly.png)
![Удержание](data_retention_heatmap.png)

## Файлы в этой папке

| Файл | Что это |
|---|---|
| `ab_summary.csv` | Главная и защитные метрики A/B одной таблицей |
| `ab_segments.csv`, `ab_monitoring.csv`, `ab_funnel.csv` | Сегменты, мониторинг, воронка |
| `ab_*.png` | Графики эксперимента |
| `data_*.csv`, `data_*.png` | Качество данных, WECU, когорты, CAC |
| `Отчёт.docx` | Отчёт по эксперименту |
"""
(OUT / 'README.md').write_text(text, encoding='utf-8')
print('results/README.md готов')
