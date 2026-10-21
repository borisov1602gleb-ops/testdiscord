"""
Обработка событий по схеме платформы:  BRONZE -> SILVER -> GOLD.

BRONZE — сырые события как есть (из generate.py).
SILVER — проверка контракта (обязательные поля, допустимые значения,
         справочники), дедупликация по event_id, единое время UTC,
         склейка anonymous_id -> user_id после регистрации. Всё, что не
         прошло проверки, уходит в карантин с причиной.
GOLD   — витрины: воронка по группам A/B и сегментам, защитные метрики,
         WECU по неделям.

Запуск:  python pipeline.py   (читает data/, пишет data/silver_*.csv, data/gold_*.csv)
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path(__file__).with_name('data')

EVENT_TYPES = {'invite_link_opened', 'call_joined', 'registration_completed', 'community_joined',
               'community_interaction', 'error_occurred', 'community_left'}
ACTION_TYPES = {'message', 'call'}
JOIN_STATUSES = {'success', 'failed'}

# Обязательные поля по типам событий. Идентификатор человека —
# user_id или anonymous_id — проверяется отдельно.
REQUIRED = {
    'invite_link_opened': ['invite_id', 'community_id', 'device_id', 'platform_id'],
    'call_joined': ['call_id', 'community_id', 'invite_id', 'join_status', 'platform_id'],
    'registration_completed': ['user_id', 'registration_source', 'platform_id'],
    'community_joined': ['user_id', 'community_id', 'join_source', 'platform_id'],
    'community_interaction': ['user_id', 'community_id', 'action_type', 'platform_id'],
    'error_occurred': ['error_type', 'platform_id'],
    'community_left': ['user_id', 'community_id', 'leave_reason', 'platform_id'],
}


def load(name: str) -> pd.DataFrame:
    return pd.read_csv(DATA / f'{name}.csv', low_memory=False)


# ===== SILVER =============================================================

def to_silver(bronze: pd.DataFrame, communities: pd.DataFrame, invites: pd.DataFrame):
    """Возвращает (silver, quarantine). У каждой строки карантина — причина."""
    df = bronze.copy()
    reasons = pd.Series('', index=df.index)

    def flag(mask, reason):
        nonlocal reasons
        mask = mask & (reasons == '')
        reasons[mask] = reason

    # 1. Уникальность: первая запись с event_id остаётся, повторы — в карантин.
    flag(df.duplicated('event_id', keep='first'), 'duplicate_event_id')
    # 2. Полнота: event_id, время и хотя бы один идентификатор человека.
    flag(df.event_id.isna() | df.timestamp.isna(), 'missing_event_id_or_timestamp')
    flag(df.user_id.isna() & df.anonymous_id.isna(), 'missing_person_id')
    flag(~df.event_type.isin(EVENT_TYPES), 'unknown_event_type')
    for etype, fields in REQUIRED.items():
        is_type = df.event_type == etype
        for f in fields:
            flag(is_type & df[f].isna(), f'missing_{f}')
    # 3. Допустимость и согласованность значений.
    flag((df.event_type == 'community_interaction') & ~df.action_type.isin(ACTION_TYPES), 'bad_action_type')
    flag((df.event_type == 'call_joined') & ~df.join_status.isin(JOIN_STATUSES), 'bad_join_status')
    flag(df.duration_sec.notna() & (df.duration_sec < 0), 'negative_duration')
    flag(df.community_id.notna() & ~df.community_id.isin(communities.community_id), 'unknown_community')
    flag(df.invite_id.notna() & ~df.invite_id.isin(invites.invite_id), 'unknown_invite')

    quarantine = df[reasons != ''].assign(reason=reasons[reasons != ''])
    silver = df[reasons == ''].copy()

    # Единое время: всё в UTC.
    silver['timestamp_utc'] = pd.to_datetime(silver.pop('timestamp'), utc=True, format='mixed')

    # Склейка: после регистрации anonymous_id и user_id — один человек.
    links = (silver[(silver.event_type == 'registration_completed') & silver.anonymous_id.notna()]
             [['anonymous_id', 'user_id']].drop_duplicates('anonymous_id'))
    anon_to_user = dict(zip(links.anonymous_id, links.user_id))
    silver['person_id'] = silver.user_id.fillna(silver.anonymous_id.map(anon_to_user)).fillna(silver.anonymous_id)
    silver = silver.sort_values('timestamp_utc').reset_index(drop=True)
    return silver, quarantine


# ===== GOLD ===============================================================

def person_table(silver: pd.DataFrame, assignments: pd.DataFrame, k_days: int = 7, n_days: int = 7):
    """Одна строка на участника эксперимента: группа, сегмент и прошёл ли
    он каждый шаг воронки и защитные метрики."""
    a = assignments.copy()
    a['assigned_at'] = pd.to_datetime(a.assigned_at, utc=True)
    # Один человек = устройство до регистрации; после — его user_id.
    links = silver[silver.event_type == 'registration_completed'][['anonymous_id', 'user_id']].dropna()
    a = a.merge(links.drop_duplicates('anonymous_id'), on='anonymous_id', how='left')
    a['person_id'] = a.user_id_at_open.fillna(a.user_id).fillna(a.anonymous_id)

    ev = silver
    first = lambda etype, cond=None: (ev[(ev.event_type == etype) & (cond if cond is not None else True)]
                                      .groupby('person_id').timestamp_utc.min())
    opened = first('invite_link_opened')
    call_ok = first('call_joined', ev.join_status == 'success')
    call_try = ev[ev.event_type == 'call_joined'].groupby('person_id').size()
    errors = ev[ev.event_type == 'error_occurred'].groupby('person_id').size()
    reg = first('registration_completed')
    joined = ev[ev.event_type == 'community_joined'].groupby('person_id').agg(
        joined_at=('timestamp_utc', 'min'), joined_community=('community_id', 'first'))
    left = first('community_left')

    t = a.set_index('person_id')
    t['opened'] = t.index.isin(opened.index)
    t['call_joined'] = t.index.isin(call_ok.index)
    t['call_attempts'] = call_try.reindex(t.index).fillna(0).astype(int)
    t['join_errors'] = errors.reindex(t.index).fillna(0).astype(int)
    t['registered'] = t.index.isin(reg.index) | t.user_id_at_open.notna()
    t['new_registration'] = t.index.isin(reg.index)
    t = t.join(joined)
    t['community_joined'] = t.joined_at.notna()
    t['left_at'] = left.reindex(t.index)

    # Активность в сообществе после вступления.
    inter = ev[ev.event_type == 'community_interaction'][['person_id', 'community_id', 'timestamp_utc']]
    inter = inter.merge(t[['joined_at', 'joined_community']].dropna().reset_index(), on='person_id')
    inter = inter[inter.community_id == inter.joined_community]
    days_after = (inter.timestamp_utc - inter.joined_at).dt.total_seconds() / 86400
    activated = inter[(days_after >= 0) & (days_after <= n_days)].person_id.unique()
    returned_d7 = inter[(days_after >= 7) & (days_after < 14)].person_id.unique()

    j = t.community_joined
    t['activated'] = np.where(j, t.index.isin(activated), np.nan)
    t['retained_d7'] = np.where(j, t.index.isin(returned_d7), np.nan)
    early = (t.left_at - t.joined_at).dt.total_seconds() / 86400 <= k_days
    t['left_early'] = np.where(j, early.fillna(False), np.nan)
    return t.reset_index()


def funnel(people: pd.DataFrame, by=('group',)) -> pd.DataFrame:
    """Воронка нового пользователя по группам и, если нужно, сегментам."""
    g = people.groupby(list(by))
    out = pd.DataFrame({
        'opened_invite': g.opened.sum(),
        'call_joined': g.call_joined.sum(),
        'registered_new': g.new_registration.sum(),
        'community_joined': g.community_joined.sum(),
        'activated': g.activated.sum(),
        'retained_d7': g.retained_d7.sum(),
    })
    out['cr_call_join'] = out.call_joined / out.opened_invite
    return out


def wecu_weekly(silver: pd.DataFrame, n_messages: int = 5, call_minutes: int = 30) -> pd.DataFrame:
    """WECU по неделям: уникальные люди с >= N сообщений или >= M минут
    в звонках сообщества за неделю."""
    it = silver[silver.event_type == 'community_interaction'].copy()
    local = it.timestamp_utc.dt.tz_convert('Europe/Moscow').dt.tz_localize(None)
    it['week'] = local.dt.to_period('W-SUN').astype(str)
    it['is_msg'] = it.action_type == 'message'
    it['call_min'] = np.where(it.action_type == 'call', it.duration_sec.fillna(0) / 60, 0)
    per = it.groupby(['week', 'person_id']).agg(messages=('is_msg', 'sum'), call_min=('call_min', 'sum'))
    per['engaged'] = (per.messages >= n_messages) | (per.call_min >= call_minutes)
    weekly = per.groupby('week').agg(active_users=('engaged', 'size'), wecu=('engaged', 'sum'),
                                     messages=('messages', 'sum'), call_minutes=('call_min', 'sum'))
    weekly['call_minutes'] = weekly.call_minutes.round()
    return weekly


def run(save: bool = True):
    bronze, communities, invites, assignments = (load(n) for n in ['bronze_events', 'communities', 'invites', 'assignments'])
    silver, quarantine = to_silver(bronze, communities, invites)
    people = person_table(silver, assignments)
    gold_funnel = funnel(people)
    gold_funnel_seg = funnel(people, by=('segment', 'group'))
    weekly = wecu_weekly(silver)
    print(f'Bronze: {len(bronze)}  ->  Silver: {len(silver)},  карантин: {len(quarantine)}')
    print(quarantine.reason.value_counts().to_string())
    if save:
        silver.to_csv(DATA / 'silver_events.csv', index=False)
        quarantine.to_csv(DATA / 'quarantine.csv', index=False)
        people.to_csv(DATA / 'gold_ab_people.csv', index=False)
        gold_funnel.to_csv(DATA / 'gold_funnel.csv')
        gold_funnel_seg.to_csv(DATA / 'gold_funnel_by_segment.csv')
        weekly.to_csv(DATA / 'gold_wecu_weekly.csv')
    return dict(bronze=bronze, silver=silver, quarantine=quarantine, people=people,
                funnel=gold_funnel, funnel_seg=gold_funnel_seg, weekly=weekly)


if __name__ == '__main__':
    run()
