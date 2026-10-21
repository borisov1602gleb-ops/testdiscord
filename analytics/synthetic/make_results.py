"""
Собирает результаты в папку results/: таблицы CSV и графики PNG.

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
import pipeline  # noqa: E402

OUT = HERE / 'results'
OUT.mkdir(exist_ok=True)

# ===== эксперимент =====
r = pipeline.run(save=False)
res = analysis.run(r['people'], r['weekly'])
m, s, pl, aa = res['main'], res['srm'], res['planning'], res['aa']

for name in ['funnel', 'segments', 'monitoring', 'aa', 'wecu']:
    shutil.copy(HERE / 'ab_experiment' / 'charts' / f'{name}.png', OUT / f'ab_{name}.png')

# Главная и защитные метрики одной таблицей.
summary = pd.DataFrame([
    ['Conversion to Call Join', m['A'], m['B'], m['diff'], m['ci_low'], m['ci_high'], m['p_value'],
     'значимо' if m['significant'] else 'не значимо'],
    *[[g['Метрика'], g['A'], g['B'], g['Разница B−A'], *map(float, g['ДИ 95%'].strip('[]').split(';')),
       g['p-value'], g['Статус']] for _, g in res['guardrails'].iterrows()],
], columns=['metric', 'A', 'B', 'diff', 'ci_low', 'ci_high', 'p_value', 'status'])
summary.to_csv(OUT / 'ab_summary.csv', index=False)

# Ключевые числа дизайна и проверок.
pd.DataFrame([
    ['n_A', s['n_A']], ['n_B', s['n_B']], ['srm_p_value', s['p_value']],
    ['baseline_p1', pl['p1']], ['mde', pl['mde']], ['sample_size_per_group', pl['n_per_group']],
    ['duration_days', pl['days']], ['lift_relative', m['lift']], ['z', m['z']],
    ['aa_false_positive_rate', aa['false_positive_rate']], ['aa_ks_p_value', aa['ks_p_value']],
], columns=['name', 'value']).to_csv(OUT / 'ab_key_numbers.csv', index=False)

res['segments'].to_csv(OUT / 'ab_segments.csv', index=False)
res['monitoring'].to_csv(OUT / 'ab_monitoring.csv', index=False)
res['diagnostics'].to_csv(OUT / 'ab_funnel_steps.csv')
r['funnel'].to_csv(OUT / 'ab_funnel.csv')
r['quarantine'].reason.value_counts().rename('rows').to_csv(OUT / 'ab_quarantine_reasons.csv')

# ===== данные и метрики продукта (модуль синтетики) =====
mod = HERE / 'output'
for name in ['data_quality', 'funnel_ab', 'wecu_weekly', 'retention_heatmap']:
    shutil.copy(mod / f'{name}.png', OUT / f'data_{name}.png')
for name in ['data_quality_report', 'gold_retention_cohorts', 'gold_cac_by_channel', 'gold_wecu_weekly']:
    shutil.copy(mod / f'{name}.csv', OUT / f'data_{name}.csv')

print(f'Результаты сохранены в {OUT}/')
