"""
Статистика A/B-теста и графики.

- размер выборки и длительность (формула для двух долей);
- проверка баланса групп (SRM, хи-квадрат);
- главная метрика: Conversion to Call Join, z-тест двух долей,
  доверительный интервал разницы;
- защитные метрики с границами X, Y, Z;
- сегменты (гость / с аккаунтом / уже участник) с поправкой Бонферрони;
- последовательный мониторинг с границами О'Брайена–Флеминга;
- A/A-тест: на одинаковых группах тест не должен «находить» эффект.
"""
from __future__ import annotations

from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy import stats

CHARTS = Path(__file__).with_name('charts')
ALPHA = 0.05
POWER = 0.80
# Границы защитных метрик (фиксируются до запуска).
GUARDRAILS = {
    'activated': ('Activation Rate', 'lower', 0.05),      # B ниже A больше чем на 5 п.п. — плохо
    'left_early': ('Доля раннего выхода', 'higher', 0.05),  # B выше A больше чем на 5 п.п. — плохо
    'retained_d7': ('Community Retention D7', 'lower', 0.05),
}
ERROR_REL_LIMIT = 0.30  # доля ошибок в B выше A больше чем на 30% относительно — плохо
SEGMENT_LABELS = {'guest': 'Гость (без аккаунта)', 'user': 'С аккаунтом, не в сообществе',
                  'member': 'Уже участник сообщества'}
COLORS = {'A': '#8A93A8', 'B': '#7B6CD9'}


# ===== формулы ============================================================

def sample_size(p1: float, mde: float, alpha: float = ALPHA, power: float = POWER) -> int:
    """n на группу: n ≈ 2·(z₁₋α/₂ + z₁₋β)²·p̄(1−p̄)/Δ²."""
    z_a = stats.norm.ppf(1 - alpha / 2)
    z_b = stats.norm.ppf(power)
    p2 = p1 + mde
    p_bar = (p1 + p2) / 2
    return int(np.ceil(2 * (z_a + z_b) ** 2 * p_bar * (1 - p_bar) / mde ** 2))


def srm_test(n_a: int, n_b: int) -> dict:
    """Перекос групп: фактическое деление против ожидаемых 50/50."""
    total = n_a + n_b
    chi2, p = stats.chisquare([n_a, n_b], [total / 2, total / 2])
    return {'n_A': n_a, 'n_B': n_b, 'share_B': n_b / total, 'chi2': chi2, 'p_value': p,
            'ok': p >= 0.001}


def two_prop_test(x_a: int, n_a: int, x_b: int, n_b: int, alpha: float = ALPHA) -> dict:
    """z-тест двух долей (объединённая дисперсия для p-value) и
    доверительный интервал разницы B − A."""
    p_a, p_b = x_a / n_a, x_b / n_b
    pooled = (x_a + x_b) / (n_a + n_b)
    se_pooled = np.sqrt(pooled * (1 - pooled) * (1 / n_a + 1 / n_b))
    z = (p_b - p_a) / se_pooled if se_pooled > 0 else 0.0
    p_value = 2 * (1 - stats.norm.cdf(abs(z)))
    se = np.sqrt(p_a * (1 - p_a) / n_a + p_b * (1 - p_b) / n_b)
    z_crit = stats.norm.ppf(1 - alpha / 2)
    diff = p_b - p_a
    return {'A': p_a, 'B': p_b, 'diff': diff, 'ci_low': diff - z_crit * se, 'ci_high': diff + z_crit * se,
            'lift': diff / p_a if p_a else np.nan, 'z': z, 'p_value': p_value, 'significant': p_value < alpha,
            'n_A': n_a, 'n_B': n_b}


def obrien_fleming_bounds(k_looks: int, alpha: float = ALPHA) -> list[float]:
    """Границы О'Брайена–Флеминга для K равных промежуточных проверок:
    c_k = C·sqrt(K/k). Константа C подбирается так, чтобы общий риск
    ложной тревоги остался α (известные значения из таблиц)."""
    constants = {1: 1.960, 2: 1.977, 3: 2.004, 4: 2.024, 5: 2.040}
    c = constants[k_looks] if alpha == 0.05 else stats.norm.ppf(1 - alpha / 2)
    return [c * np.sqrt(k_looks / k) for k in range(1, k_looks + 1)]


# ===== анализ ============================================================

def main_metric(people: pd.DataFrame) -> dict:
    opened = people[people.opened]
    g = opened.groupby('group').call_joined.agg(['sum', 'count'])
    return two_prop_test(g.loc['A', 'sum'], g.loc['A', 'count'], g.loc['B', 'sum'], g.loc['B', 'count'])


def guardrails(people: pd.DataFrame) -> pd.DataFrame:
    rows = []
    joined = people[people.community_joined]
    for col, (label, bad, limit) in GUARDRAILS.items():
        g = joined.groupby('group')[col].agg(['sum', 'count'])
        r = two_prop_test(g.loc['A', 'sum'], g.loc['A', 'count'], g.loc['B', 'sum'], g.loc['B', 'count'])
        worse = -r['diff'] if bad == 'lower' else r['diff']
        rows.append({'Метрика': label, 'A': r['A'], 'B': r['B'], 'Разница B−A': r['diff'],
                     'ДИ 95%': f"[{r['ci_low']:+.3f}; {r['ci_high']:+.3f}]", 'p-value': r['p_value'],
                     'Граница': f"{'−' if bad == 'lower' else '+'}{limit * 100:.0f} п.п.",
                     'Статус': 'в границах' if worse <= limit else 'НАРУШЕНА'})
    g = people.groupby('group')[['join_errors', 'call_attempts']].sum()
    r = two_prop_test(g.loc['A', 'join_errors'], g.loc['A', 'call_attempts'],
                      g.loc['B', 'join_errors'], g.loc['B', 'call_attempts'])
    rel = r['B'] / r['A'] - 1
    rows.append({'Метрика': 'Доля технических ошибок', 'A': r['A'], 'B': r['B'], 'Разница B−A': r['diff'],
                 'ДИ 95%': f"[{r['ci_low']:+.3f}; {r['ci_high']:+.3f}]", 'p-value': r['p_value'],
                 'Граница': f'+{ERROR_REL_LIMIT * 100:.0f}% относительно',
                 'Статус': 'в границах' if rel <= ERROR_REL_LIMIT else 'НАРУШЕНА'})
    return pd.DataFrame(rows)


def by_segment(people: pd.DataFrame) -> pd.DataFrame:
    """Конверсия в звонок по сегментам с поправкой Бонферрони (α / 3)."""
    opened = people[people.opened]
    segments = ['guest', 'user', 'member']
    alpha = ALPHA / len(segments)
    rows = []
    for s in segments:
        g = opened[opened.segment == s].groupby('group').call_joined.agg(['sum', 'count'])
        r = two_prop_test(g.loc['A', 'sum'], g.loc['A', 'count'], g.loc['B', 'sum'], g.loc['B', 'count'], alpha)
        rows.append({'Сегмент': SEGMENT_LABELS[s], 'n A': r['n_A'], 'n B': r['n_B'], 'A': r['A'], 'B': r['B'],
                     'Разница': r['diff'], 'ДИ (с поправкой)': f"[{r['ci_low']:+.3f}; {r['ci_high']:+.3f}]",
                     'p-value': r['p_value'], f'Значимо при α={alpha:.4f}': 'да' if r['p_value'] < alpha else 'нет'})
    return pd.DataFrame(rows)


def diagnostics(people: pd.DataFrame) -> pd.DataFrame:
    """Диагностические конверсии шагов воронки (для понимания, где эффект)."""
    rows = []
    for grp, g in people[people.opened].groupby('group'):
        guests = g[g.segment == 'guest']
        rows.append({
            'Группа': grp,
            'Открыли → звонок': g.call_joined.mean(),
            'Гость: звонок → регистрация': guests[guests.call_joined].new_registration.mean(),
            'Гость: открыл → регистрация': guests.new_registration.mean(),
            'Регистрация → вступление': g[g.new_registration].community_joined.mean(),
            'Вступление → активация': g[g.community_joined].activated.mean(),
        })
    return pd.DataFrame(rows).set_index('Группа').T


def sequential_monitoring(people: pd.DataFrame, enroll_days: int = 21, looks: int = 3) -> pd.DataFrame:
    """Промежуточные проверки после 7, 14 и 21 дня набора (накопительно).
    Досрочная остановка — только если |z| пересёк границу О'Брайена–Флеминга."""
    bounds = obrien_fleming_bounds(looks)
    start = people.assigned_at.min().normalize()
    rows = []
    for k in range(1, looks + 1):
        cutoff = start + pd.Timedelta(days=enroll_days * k / looks)
        part = people[(people.assigned_at < cutoff) & people.opened]
        g = part.groupby('group').call_joined.agg(['sum', 'count'])
        r = two_prop_test(g.loc['A', 'sum'], g.loc['A', 'count'], g.loc['B', 'sum'], g.loc['B', 'count'])
        rows.append({'Проверка': f'день {enroll_days * k // looks}', 'Участников': int(g['count'].sum()),
                     'A': r['A'], 'B': r['B'], 'z': r['z'], 'Граница |z|': bounds[k - 1],
                     'Пересекли': 'да' if abs(r['z']) >= bounds[k - 1] else 'нет'})
    return pd.DataFrame(rows)


def aa_test(people: pd.DataFrame, runs: int = 1000, seed: int = 7) -> dict:
    """A/A: берём только группу A, много раз случайно делим её пополам и
    сравниваем. Эффекта нет, поэтому значимых результатов должно быть ≈5%,
    а p-value — распределены равномерно."""
    rng = np.random.default_rng(seed)
    a = people[people.opened & (people.group == 'A')].call_joined.to_numpy().astype(int)
    pvals = []
    for _ in range(runs):
        mask = rng.random(len(a)) < 0.5
        x1, n1, x2, n2 = a[mask].sum(), mask.sum(), a[~mask].sum(), (~mask).sum()
        pvals.append(two_prop_test(x1, n1, x2, n2)['p_value'])
    pvals = np.array(pvals)
    ks = stats.kstest(pvals, 'uniform')
    return {'pvalues': pvals, 'false_positive_rate': float((pvals < ALPHA).mean()), 'ks_p_value': ks.pvalue}


def planning(people: pd.DataFrame, mde: float = 0.03) -> dict:
    """Расчёт выборки «как до запуска»: базовая конверсия берётся из
    первой недели группы A (в реальности — из исторических данных)."""
    opened = people[people.opened]
    first_week = opened[opened.assigned_at < opened.assigned_at.min() + pd.Timedelta(days=7)]
    p1 = first_week[first_week.group == 'A'].call_joined.mean()
    n = sample_size(p1, mde)
    per_day = len(opened) / 21
    days = max(14, int(np.ceil(2 * n / per_day)))
    return {'p1': p1, 'mde': mde, 'n_per_group': n, 'total': 2 * n, 'opens_per_day': per_day, 'days': days,
            'n_for_mde': {m: sample_size(p1, m) for m in (0.01, 0.02, 0.03, 0.05)}}


# ===== графики ============================================================

def _style(ax, title):
    ax.set_title(title, fontsize=12, loc='left', pad=10)
    ax.spines[['top', 'right']].set_visible(False)
    ax.grid(axis='y', alpha=0.25)


def chart_funnel(people: pd.DataFrame, path: Path):
    guests = people[people.opened & (people.segment == 'guest')]
    steps = [('Открыли\nприглашение', 'opened'), ('Подключились\nк звонку', 'call_joined'),
             ('Зарегистри-\nровались', 'new_registration'), ('Вступили\nв сообщество', 'community_joined'),
             ('Активация', 'activated'), ('Вернулись\nна D7', 'retained_d7')]
    fig, ax = plt.subplots(figsize=(10, 4.8))
    x = np.arange(len(steps))
    for i, grp in enumerate(['A', 'B']):
        g = guests[guests.group == grp]
        vals = [g[col].fillna(0).astype(bool).sum() / len(g) * 100 for _, col in steps]
        bars = ax.bar(x + (i - 0.5) * 0.38, vals, 0.36, color=COLORS[grp], label=f'Группа {grp}')
        for b, v in zip(bars, vals):
            ax.text(b.get_x() + b.get_width() / 2, v + 1, f'{v:.0f}%', ha='center', fontsize=9)
    ax.set_xticks(x, [s for s, _ in steps], fontsize=9)
    ax.set_ylabel('% от открывших приглашение')
    ax.legend(frameon=False)
    _style(ax, 'Воронка гостя (без аккаунта): A — регистрация до звонка, B — вход по ссылке')
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def chart_segments(seg: pd.DataFrame, main: dict, path: Path):
    fig, ax = plt.subplots(figsize=(10, 4.2))
    labels = ['Все'] + list(seg['Сегмент'])
    diffs = [main['diff']] + list(seg['Разница'])
    lows = [main['ci_low']] + [float(s.split(';')[0][1:]) for s in seg['ДИ (с поправкой)']]
    highs = [main['ci_high']] + [float(s.split(';')[1][:-1]) for s in seg['ДИ (с поправкой)']]
    y = np.arange(len(labels))[::-1]
    for yi, d, lo, hi in zip(y, diffs, lows, highs):
        ax.plot([lo * 100, hi * 100], [yi, yi], color=COLORS['B'], lw=3, solid_capstyle='round')
        ax.plot(d * 100, yi, 'o', color='white', mec=COLORS['B'], mew=2, ms=8)
        ax.text(hi * 100 + 0.4, yi, f'{d * 100:+.1f} п.п.', va='center', fontsize=9)
    ax.axvline(0, color='#555', lw=1)
    ax.set_yticks(y, labels)
    ax.set_xlabel('Разница конверсии в звонок, B − A, п.п. (95% ДИ; для сегментов — с поправкой Бонферрони)')
    _style(ax, 'Эффект по сегментам')
    ax.grid(axis='x', alpha=0.25)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def chart_wecu(weekly: pd.DataFrame, path: Path):
    fig, ax = plt.subplots(figsize=(10, 4))
    labels = [w.split('/')[0][5:] for w in weekly.index]
    ax.plot(labels, weekly.wecu, marker='o', color=COLORS['B'], lw=2, label='WECU (вовлечённые)')
    ax.plot(labels, weekly.active_users, marker='o', color=COLORS['A'], lw=2, label='Хоть раз активны')
    for xi, v in zip(labels, weekly.wecu):
        ax.text(xi, v + 120, f'{v:,}'.replace(',', ' '), ha='center', fontsize=9)
    ax.set_xlabel('Неделя (начало, ММ-ДД)')
    ax.set_ylabel('Пользователей')
    ax.legend(frameon=False)
    _style(ax, 'WECU по неделям: ≥5 сообщений или ≥30 минут в звонках сообщества')
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def chart_monitoring(mon: pd.DataFrame, path: Path):
    fig, ax = plt.subplots(figsize=(10, 4))
    ax.plot(mon['Проверка'], mon['z'], marker='o', color=COLORS['B'], lw=2, label='z-статистика (B против A)')
    ax.plot(mon['Проверка'], mon['Граница |z|'], ls='--', color='#C0504D', lw=1.5, label="Граница О'Брайена–Флеминга")
    ax.axhline(1.96, color='#999', lw=1, ls=':', label='1,96 (обычный порог без поправки)')
    ax.legend(frameon=False)
    _style(ax, 'Последовательный мониторинг главной метрики')
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def chart_aa(aa: dict, path: Path):
    fig, ax = plt.subplots(figsize=(10, 3.8))
    ax.hist(aa['pvalues'], bins=20, range=(0, 1), color=COLORS['A'], edgecolor='white')
    ax.axhline(len(aa['pvalues']) / 20, color=COLORS['B'], ls='--', lw=1.5, label='Ожидаемо при равномерном распределении')
    ax.set_xlabel('p-value')
    ax.set_ylabel('Число запусков')
    ax.legend(frameon=False)
    _style(ax, f"A/A-тест: 1000 случайных делений группы A — ложных срабатываний {aa['false_positive_rate'] * 100:.1f}% (норма ≈5%)")
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def make_charts(people, weekly, seg, main, mon, aa) -> dict[str, Path]:
    CHARTS.mkdir(exist_ok=True)
    paths = {k: CHARTS / f'{k}.png' for k in ['funnel', 'segments', 'wecu', 'monitoring', 'aa']}
    chart_funnel(people, paths['funnel'])
    chart_segments(seg, main, paths['segments'])
    chart_wecu(weekly, paths['wecu'])
    chart_monitoring(mon, paths['monitoring'])
    chart_aa(aa, paths['aa'])
    return paths


def decision(main: dict, guards: pd.DataFrame, srm: dict) -> str:
    if not srm['ok']:
        return 'Результаты не интерпретируем: группы разделились не 50/50 (SRM).'
    broken = guards[guards['Статус'] != 'в границах']
    if main['significant'] and main['diff'] > 0 and broken.empty:
        return ('Внедряем: конверсия в B значимо выше, защитные метрики в границах. '
                'Небольшое снижение активации и удержания в B стоит наблюдать после запуска.')
    if main['significant'] and main['diff'] > 0:
        return 'Не внедряем: главная метрика выросла, но нарушены защитные: ' + ', '.join(broken['Метрика'])
    return 'Не внедряем: значимого эффекта нет.'


def run(people: pd.DataFrame, weekly: pd.DataFrame) -> dict:
    people = people.copy()
    people['assigned_at'] = pd.to_datetime(people.assigned_at, utc=True)
    opened = people[people.opened]
    res = {
        'planning': planning(people),
        'srm': srm_test(int((opened.group == 'A').sum()), int((opened.group == 'B').sum())),
        'main': main_metric(people),
        'guardrails': guardrails(people),
        'segments': by_segment(people),
        'diagnostics': diagnostics(people),
        'monitoring': sequential_monitoring(people),
        'aa': aa_test(people),
    }
    res['decision'] = decision(res['main'], res['guardrails'], res['srm'])
    res['charts'] = make_charts(people, weekly, res['segments'], res['main'], res['monitoring'], res['aa'])
    return res


if __name__ == '__main__':
    import pipeline
    r = pipeline.run(save=False)
    out = run(r['people'], r['weekly'])
    for k in ['planning', 'srm', 'main']:
        print(k, out[k])
    for k in ['guardrails', 'segments', 'diagnostics', 'monitoring']:
        print(out[k].to_string())
    print('A/A:', out['aa']['false_positive_rate'], out['aa']['ks_p_value'])
    print('Решение:', out['decision'])
