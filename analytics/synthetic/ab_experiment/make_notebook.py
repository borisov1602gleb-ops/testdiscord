"""Собирает и прогоняет ноутбук ab_test.ipynb (результаты сохраняются внутри)."""
from pathlib import Path

import nbformat as nbf
from nbconvert.preprocessors import ExecutePreprocessor

HERE = Path(__file__).parent
md, code = nbf.v4.new_markdown_cell, nbf.v4.new_code_cell

cells = [
    md("""# A/B-тест «вход в звонок по ссылке без регистрации» на синтетических данных

**Платформа тематических сообществ.**

Реальных пользователей у платформы пока нет, поэтому схему событий, метрики и дизайн эксперимента проверяем на **синтетических данных**:

1. `generate.py` — «придумывает» 24 000 человек, делит их на группы A и B и проигрывает путь каждого по воронке. Пишет события в бронзовый слой по схеме событий платформы и нарочно подмешивает «грязь».
2. `pipeline.py` — чистит данные: Bronze → Silver → Gold, карантин с причинами, склейка гостя с аккаунтом.
3. `analysis.py` — считает метрики и A/B-тест, строит графики.

Эффект в группе B **заложен заранее** (у гостей +12 п.п. к конверсии в звонок). Так проверяем сам метод: должен ли тест его найти и не находит ли он эффект там, где его нет (A/A-тест).

> Все вероятности в генераторе — допущения модели, а не реальные данные. Они собраны в `Config` в начале `generate.py`: их можно поменять и перезапустить ноутбук."""),
    code("""import pandas as pd
pd.set_option('display.float_format', lambda v: f'{v:,.4f}')
pd.set_option('display.width', 160)
from IPython.display import Image, display

import generate, pipeline, analysis
cfg = generate.Config()
print('Участников эксперимента:', cfg.n_people, '| набор:', cfg.enroll_days, 'дн. | наблюдение:', cfg.observe_days, 'дн.')
print('Заложенные конверсии в звонок (группа, сегмент):')
for k, v in cfg.p_call_join.items():
    print(f'  {k}: {v:.0%}')"""),
    md("## 1. Генерация бронзового слоя\nСобытия: `invite_link_opened`, `call_joined`, `registration_completed`, `community_joined`, `community_interaction`, `error_occurred`, `community_left`. Группа назначается по хешу устройства — один человек всегда в одной группе."),
    code("""tables = generate.generate(cfg)
bronze = tables['bronze_events']
display(bronze.head(8))
display(bronze.event_type.value_counts().rename('событий').to_frame())"""),
    md("## 2. Silver: проверки качества\nПолнота (event_id, время, идентификатор человека, обязательные поля), уникальность event_id, допустимые значения (`action_type`, `join_status`, неотрицательная длительность), существование сообщества и приглашения в справочниках. Всё, что не прошло, — в карантин с причиной. Время приводится к UTC, `anonymous_id` склеивается с `user_id` после регистрации."),
    code("""r = pipeline.run()
silver, quarantine, people = r['silver'], r['quarantine'], r['people']
print(f'Bronze: {len(bronze):,}  →  Silver: {len(silver):,}  |  карантин: {len(quarantine):,} ({len(quarantine)/len(bronze):.1%})')
display(quarantine.reason.value_counts().rename('строк в карантине').to_frame())"""),
    md("## 3. Gold: воронка и WECU\nВоронка нового пользователя по группам и сегментам. Сегменты фиксируются в момент открытия ссылки: гость без аккаунта / с аккаунтом / уже участник сообщества."),
    code("""display(r['funnel'])
display(r['funnel_seg'])
display(r['weekly'])"""),
    md("## 4. Планирование: размер выборки и длительность\n$n \\approx 2 (z_{1-\\alpha/2} + z_{1-\\beta})^2 \\cdot \\bar p(1-\\bar p) / \\Delta^2$, α = 0,05, мощность 80%. Базовую конверсию p₁ берём из первой недели группы A — в реальности её берут из исторических данных."),
    code("""res = analysis.run(people, r['weekly'])
pl = res['planning']
print(f"p₁ = {pl['p1']:.3f},  MDE = {pl['mde']:.0%}  →  n = {pl['n_per_group']:,} на группу, всего {pl['total']:,}")
print(f"Открытий в день ≈ {pl['opens_per_day']:.0f}  →  длительность: {pl['days']} дней (не меньше 14)")
print('Как выборка зависит от MDE:', {f'{k:.0%}': f'{v:,}' for k, v in pl['n_for_mde'].items()})"""),
    md("## 5. Баланс групп (SRM)\nФактическое деление сравниваем с 50/50 критерием хи-квадрат. При p < 0,001 результаты не интерпретируем."),
    code("""s = res['srm']
print(f"A: {s['n_A']:,}  B: {s['n_B']:,}  доля B: {s['share_B']:.3f}  χ² = {s['chi2']:.2f}  p = {s['p_value']:.3f}  →  {'баланс в норме' if s['ok'] else 'ПЕРЕКОС, стоп'}")"""),
    md("## 6. Главная метрика: Conversion to Call Join\nУникальные с успешным `call_joined` / уникальные с `invite_link_opened`. z-тест двух долей, двусторонний, α = 0,05."),
    code("""m = res['main']
print(f"A: {m['A']:.2%}   B: {m['B']:.2%}")
print(f"Разница B − A: {m['diff']*100:+.1f} п.п., 95% ДИ [{m['ci_low']*100:+.1f}; {m['ci_high']*100:+.1f}] п.п., относительный прирост {m['lift']:+.1%}")
print(f"z = {m['z']:.2f}, p-value = {m['p_value']:.2e}  →  {'значимо' if m['significant'] else 'не значимо'}")"""),
    md("## 7. Защитные метрики\nГраницы фиксируем до запуска: Activation Rate и Retention D7 в B — не ниже A больше чем на 5 п.п., ранний выход — не выше больше чем на 5 п.п., доля ошибок — не выше больше чем на 30% относительно."),
    code("display(res['guardrails'])"),
    md("## 8. Сегменты (поправка Бонферрони) и диагностика воронки"),
    code("""display(res['segments'])
display(res['diagnostics'])
display(Image(res['charts']['segments']))
display(Image(res['charts']['funnel']))"""),
    md("## 9. Последовательный мониторинг\nПроверки после 7, 14 и 21 дня. Границы О'Брайена–Флеминга строже обычных 1,96 на ранних проверках, поэтому ежедневные взгляды на результат не повышают риск ложного вывода. По плану эксперимента досрочно останавливаемся только при вреде; решение по главной метрике — не раньше 14 дней."),
    code("""display(res['monitoring'])
display(Image(res['charts']['monitoring']))"""),
    md("## 10. A/A-тест: проверка самого метода\nБерём только группу A, 1000 раз случайно делим её пополам и сравниваем. Эффекта нет, поэтому значимых результатов должно быть около 5%, а p-value — распределены равномерно."),
    code("""aa = res['aa']
print(f"Ложных срабатываний: {aa['false_positive_rate']:.1%} (норма ≈ 5%);  тест равномерности p-value (KS): p = {aa['ks_p_value']:.3f}")
display(Image(res['charts']['aa']))"""),
    md("## 11. WECU по неделям"),
    code("display(Image(res['charts']['wecu']))"),
    md("### Выводы — посчитаны из результатов выше"),
    code("""true = {s: cfg.p_call_join[('B', s)] - cfg.p_call_join[('A', s)] for s in ['guest', 'user', 'member']}
seg = res['segments']
print('Нашёл ли тест заложенный эффект (конверсия в звонок, B − A):')
for (key, label), row in zip(analysis.SEGMENT_LABELS.items(), seg.itertuples()):
    lo, hi = (float(x) for x in row[7].strip('[]').split(';'))
    covered = lo <= true[key] <= hi
    print(f'  {label}: заложено {true[key]*100:+.0f} п.п., оценка {row.Разница*100:+.1f} п.п., ДИ [{lo*100:+.1f}; {hi*100:+.1f}]'
          f' — {\"накрывает\" if covered else \"НЕ накрывает\"} истинное значение')
print(f\"A/A-тест: ложных срабатываний {res['aa']['false_positive_rate']:.1%} при норме около 5%.\")
g = res['guardrails']
worse = g[(g['Разница B−A'] < 0) & g['Метрика'].isin(['Activation Rate', 'Community Retention D7'])]
print(f\"Защитные метрики: {', '.join(g['Статус'].unique())}; в B ниже: {', '.join(worse['Метрика']) or 'нет'}.\")
d = res['diagnostics']
print(f\"Регистрации гостей (открыл → регистрация): A {d.loc['Гость: открыл → регистрация', 'A']:.1%}, B {d.loc['Гость: открыл → регистрация', 'B']:.1%}\"
      ' — это следствие допущения в генераторе (сколько гостей регистрируются после звонка), на реальных данных — главный вопрос вторичной гипотезы.')
print()
print('Решение:', res['decision'])"""),
    md("Тот же `pipeline.py` и `analysis.py` можно запустить на реальных событиях платформы: поля и названия событий совпадают со схемой событий платформы. Параметры модели меняются в `Config` в начале `generate.py`."),
]

nb = nbf.v4.new_notebook(cells=cells, metadata={'kernelspec': {'name': 'python3', 'display_name': 'Python 3', 'language': 'python'},
                                                'language_info': {'name': 'python'}})
ExecutePreprocessor(timeout=900, kernel_name='python3').preprocess(nb, {'metadata': {'path': str(HERE)}})
nbf.write(nb, HERE / 'ab_test.ipynb')
print('ab_test.ipynb готов')
