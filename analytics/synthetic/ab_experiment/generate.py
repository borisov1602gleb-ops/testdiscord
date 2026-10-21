"""
Генератор синтетических данных для A/B-теста «вход в звонок по ссылке
без регистрации».

Что делает: «придумывает» людей, которые открывают ссылки-приглашения,
случайно делит их на группы A и B и проигрывает путь каждого по воронке:

    invite_link_opened -> call_joined -> registration_completed
    -> community_joined -> community_interaction (активация, удержание)
    -> community_left (ранний выход), error_occurred (технические ошибки)

События пишутся в «бронзовый» слой с полями схемы платформы — как их прислало бы
приложение. Чтобы было что чистить на серебряном слое, в данные нарочно
подмешивается «грязь»: дубли, пропуски идентификаторов, недопустимые
значения, неизвестные сообщества, разный формат времени.

Все вероятности ниже — допущения модели, а не реальные данные.
Эффект в группе B заложен заранее, чтобы проверить: найдёт ли его тест.

Запуск:  python generate.py            (данные появятся в папке data/)
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

MSK = timezone(timedelta(hours=3))


@dataclass
class Config:
    seed: int = 42
    # Сколько уникальных людей откроют приглашения за время набора.
    n_people: int = 24_000
    # Эксперимент: набор 21 день (три полные недели, не меньше 14 дней),
    # потом ещё 21 день наблюдения, чтобы досчитать удержание и активацию.
    start: datetime = datetime(2026, 9, 7, tzinfo=MSK)  # понедельник
    enroll_days: int = 21
    observe_days: int = 21
    n_communities: int = 40
    invites_per_community: tuple[int, int] = (2, 8)
    # Сколько «старожилов» уже общается в сообществах (фон для WECU).
    n_existing_members: int = 3_000

    # Кто открывает ссылку: уже с аккаунтом / ещё и состоит в сообществе.
    p_authorized: float = 0.35
    p_member_if_authorized: float = 0.40

    # --- Главный шаг: открыл приглашение -> успешно подключился к звонку.
    # Вероятности по группам и сегментам (A — нужна регистрация, B — нет).
    # Эффект заложен в основном у неавторизованных — там, где он и ожидается.
    p_call_join: dict = field(default_factory=lambda: {
        ('A', 'guest'): 0.30, ('B', 'guest'): 0.42,
        ('A', 'user'): 0.66, ('B', 'user'): 0.67,
        ('A', 'member'): 0.80, ('B', 'member'): 0.80,
    })
    # В выходные до звонка доходят чуть реже (смешивающий фактор).
    weekend_factor: float = 0.93
    # В группе A гость сначала регистрируется: доля завершивших регистрацию
    # среди гостей, открывших ссылку (а дальше из них — в звонок).
    p_register_before_call_A: float = 0.34
    # В группе B регистрация предлагается во время или после звонка.
    p_register_after_call_B: float = 0.70
    # Технические ошибки при подключении (у гостя в B чуть чаще: браузер
    # без сохранённых разрешений на микрофон).
    p_join_error: dict = field(default_factory=lambda: {'A': 0.040, 'B': 0.046})
    # Вступление в сообщество после звонка (для зарегистрированных).
    p_community_join: dict = field(default_factory=lambda: {'A': 0.72, 'B': 0.68})
    # Защитные метрики: активация, ранний выход, удержание D7.
    p_activation: dict = field(default_factory=lambda: {'A': 0.62, 'B': 0.59})
    p_early_leave: dict = field(default_factory=lambda: {'A': 0.08, 'B': 0.095})
    p_retention_d7: dict = field(default_factory=lambda: {'A': 0.41, 'B': 0.39})

    # Пороги вовлечённости WECU: N сообщений или M минут в звонках.
    wecu_messages: int = 5
    wecu_call_minutes: int = 30

    # Доли «грязи» в бронзовом слое.
    dirt_duplicates: float = 0.015
    dirt_missing_ids: float = 0.003
    dirt_bad_enum: float = 0.002
    dirt_negative_duration: float = 0.001
    dirt_unknown_community: float = 0.002
    dirt_utc_timestamps: float = 0.30  # часть событий приходит в UTC, часть в МСК

    out_dir: Path = Path(__file__).with_name('data')


PLATFORMS = ['web', 'android', 'ios', 'desktop']
PLATFORM_P = [0.45, 0.30, 0.15, 0.10]
ERROR_TYPES = ['mic_access_denied', 'connection_timeout', 'ice_failed']


def assign_group(device_id: str, salt: str = 'guest_join_v1') -> str:
    """Детерминированное деление 50/50 по хешу устройства: один и тот же
    человек всегда попадает в ту же группу, сколько бы раз он ни открывал
    ссылку: группа закрепляется при первом открытии."""
    digest = hashlib.sha256(f'{salt}:{device_id}'.encode()).digest()
    return 'A' if digest[0] % 2 == 0 else 'B'


class Generator:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.rng = np.random.default_rng(cfg.seed)
        self.events: list[dict] = []
        self.counter = 0

    # --- служебное -----------------------------------------------------
    def uid(self, prefix: str) -> str:
        return f'{prefix}_{int(self.rng.integers(0, 2**48)):012x}'

    def emit(self, event_type: str, ts: datetime, **fields):
        self.counter += 1
        self.events.append({
            'event_id': f'evt_{self.counter:08d}',
            'event_type': event_type,
            'ts': ts,
            **fields,
        })

    def chance(self, p: float) -> bool:
        return bool(self.rng.random() < p)

    # --- справочники ---------------------------------------------------
    def build_dictionaries(self):
        cfg = self.cfg
        self.communities = pd.DataFrame({
            'community_id': [f'comm_{i:03d}' for i in range(1, cfg.n_communities + 1)],
            'name': [f'Сообщество {i}' for i in range(1, cfg.n_communities + 1)],
            # Сообщества разные по «притягательности»: от этого зависят
            # и приглашения, и активность.
            'popularity': self.rng.lognormal(0, 0.6, cfg.n_communities),
        })
        rows = []
        for cid in self.communities.community_id:
            for _ in range(self.rng.integers(*cfg.invites_per_community, endpoint=True)):
                created = cfg.start - timedelta(days=int(self.rng.integers(0, 30)))
                rows.append({'invite_id': self.uid('inv'), 'community_id': cid, 'created_at': created})
        self.invites = pd.DataFrame(rows)

    # --- фон: старожилы сообществ ---------------------------------------
    def simulate_existing_members(self):
        """Уже состоящие в сообществах люди общаются каждую неделю — это
        фон, на котором считается WECU по неделям."""
        cfg = self.cfg
        weights = self.communities.popularity / self.communities.popularity.sum()
        total_days = cfg.enroll_days + cfg.observe_days
        for i in range(cfg.n_existing_members):
            user = f'user_old_{i:05d}'
            cid = self.rng.choice(self.communities.community_id, p=weights)
            activity = self.rng.gamma(1.2, 1.0)  # кто-то пишет много, кто-то почти молчит
            platform = self.rng.choice(PLATFORMS, p=PLATFORM_P)
            self.interactions(user, None, cid, cfg.start, total_days, activity, platform)

    def interactions(self, user, anon, cid, since, days, activity, platform, device=None):
        """Сообщения и звонки человека в сообществе за период."""
        for d in range(days):
            day = since + timedelta(days=d)
            n_msg = self.rng.poisson(0.9 * activity)
            for _ in range(n_msg):
                ts = day + timedelta(minutes=int(self.rng.integers(9 * 60, 24 * 60)))
                self.emit('community_interaction', ts, user_id=user, anonymous_id=anon, device_id=device,
                          community_id=cid, action_type='message', message_id=self.uid('msg'),
                          platform_id=platform)
            if self.chance(min(0.6, 0.12 * activity)):
                ts = day + timedelta(minutes=int(self.rng.integers(17 * 60, 23 * 60)))
                dur = int(self.rng.lognormal(np.log(25 * 60), 0.8))
                self.emit('community_interaction', ts, user_id=user, anonymous_id=anon, device_id=device,
                          community_id=cid, action_type='call', call_id=self.uid('call'),
                          duration_sec=dur, platform_id=platform)

    # --- участники эксперимента ----------------------------------------
    def simulate_person(self, idx: int):
        cfg = self.cfg
        device = f'dev_{idx:06d}'
        anon = f'anon_{idx:06d}'
        group = assign_group(device)
        platform = self.rng.choice(PLATFORMS, p=PLATFORM_P)
        invite = self.invites.iloc[int(self.rng.integers(0, len(self.invites)))]
        cid = invite.community_id

        authorized = self.chance(cfg.p_authorized)
        member = authorized and self.chance(cfg.p_member_if_authorized)
        segment = 'member' if member else 'user' if authorized else 'guest'
        user = f'user_{idx:06d}' if authorized else None

        # Время открытия: день набора и час (вечером чаще).
        day = int(self.rng.integers(0, cfg.enroll_days))
        hour = int(self.rng.choice(range(24), p=HOUR_P))
        opened = cfg.start + timedelta(days=day, hours=hour, minutes=int(self.rng.integers(0, 60)))
        weekend = opened.weekday() >= 5

        self.assignments.append({'device_id': device, 'anonymous_id': anon, 'user_id_at_open': user,
                                 'group': group, 'segment': segment, 'assigned_at': opened,
                                 'community_id': cid, 'invite_id': invite.invite_id})

        common = dict(device_id=device, platform_id=platform, invite_id=invite.invite_id, community_id=cid)
        self.emit('invite_link_opened', opened, user_id=user, anonymous_id=anon, **common)
        # Повторное открытие той же ссылки — группа не меняется.
        if self.chance(0.12):
            self.emit('invite_link_opened', opened + timedelta(hours=int(self.rng.integers(1, 30))),
                      user_id=user, anonymous_id=anon, **common)

        t = opened
        p_join = cfg.p_call_join[(group, segment)] * (cfg.weekend_factor if weekend else 1.0)
        registered = authorized

        # Группа A: гость сначала регистрируется, потом идёт в звонок.
        if group == 'A' and segment == 'guest':
            p_reg = cfg.p_register_before_call_A
            if self.chance(p_reg):
                t += timedelta(minutes=int(self.rng.integers(2, 15)))
                user = f'user_{idx:06d}'
                registered = True
                self.emit('registration_completed', t, user_id=user, anonymous_id=anon,
                          registration_source='invite', **common)
                p_join = min(0.99, p_join / p_reg)  # из зарегистрировавшихся до звонка доходят почти все
            else:
                p_join = 0.0

        joined = self.chance(p_join)
        attempted = joined or self.chance(0.35 if p_join > 0 else 0.0)
        if attempted:
            t += timedelta(minutes=int(self.rng.integers(1, 6)))
            call_id = self.uid('call')
            if self.chance(cfg.p_join_error[group]):
                self.emit('error_occurred', t, user_id=user, anonymous_id=anon, device_id=device,
                          platform_id=platform, error_type=self.rng.choice(ERROR_TYPES))
            self.emit('call_joined', t, user_id=user, anonymous_id=anon, call_id=call_id,
                      join_status='success' if joined else 'failed', **common)
        if not joined:
            return
        call_minutes = max(1, int(self.rng.lognormal(np.log(22), 0.7)))
        t += timedelta(minutes=call_minutes)

        # Группа B: гость после звонка может зарегистрироваться.
        if not registered:
            if not self.chance(cfg.p_register_after_call_B):
                return
            t += timedelta(minutes=int(self.rng.integers(1, 20)))
            user = f'user_{idx:06d}'
            registered = True
            self.emit('registration_completed', t, user_id=user, anonymous_id=anon,
                      registration_source='after_call', **common)

        if member:
            # Уже состоит — вступать не нужно; дальше просто общается.
            self.interactions(user, None, cid, t, 14, self.rng.gamma(1.5, 1.0), platform, device)
            return
        if not self.chance(cfg.p_community_join[group]):
            return
        t += timedelta(minutes=int(self.rng.integers(1, 30)))
        self.emit('community_joined', t, user_id=user, community_id=cid, invite_id=invite.invite_id,
                  join_source='invite', platform_id=platform, device_id=device)

        # Ранний выход (в течение K = 7 дней).
        if self.chance(cfg.p_early_leave[group]):
            left = t + timedelta(days=float(self.rng.uniform(0.2, 7)))
            if self.chance(0.3):
                self.interactions(user, None, cid, t, 1, 1.0, platform, device)
            self.emit('community_left', left, user_id=user, community_id=cid, platform_id=platform,
                      leave_reason=self.rng.choice(['self', 'kicked'], p=[0.85, 0.15]))
            return

        # Активация — значимое действие за первые 7 дней.
        if self.chance(cfg.p_activation[group]):
            self.interactions(user, None, cid, t, 3, self.rng.gamma(1.6, 1.0), platform, device)
        # Удержание D7 — снова пришёл в то же сообщество на 7–13 день.
        if self.chance(cfg.p_retention_d7[group]):
            later = t + timedelta(days=7)
            span = max(1, min(14, (cfg.start + timedelta(days=cfg.enroll_days + cfg.observe_days) - later).days))
            self.interactions(user, None, cid, later, span, self.rng.gamma(1.4, 1.0), platform, device)

    # --- «грязь» в бронзовом слое ---------------------------------------
    def add_dirt(self, df: pd.DataFrame) -> pd.DataFrame:
        cfg, rng = self.cfg, self.rng
        n = len(df)
        dup = df.sample(frac=cfg.dirt_duplicates, random_state=cfg.seed)
        df = pd.concat([df, dup], ignore_index=True)

        def pick(frac):
            return rng.random(len(df)) < frac
        m = pick(cfg.dirt_missing_ids)
        df.loc[m, ['user_id', 'anonymous_id']] = None
        m = pick(cfg.dirt_bad_enum) & (df.event_type == 'community_interaction')
        df.loc[m, 'action_type'] = rng.choice(['2', 'video', 'MSG'], m.sum())
        m = pick(cfg.dirt_bad_enum) & (df.event_type == 'call_joined')
        df.loc[m, 'join_status'] = 'ok'
        m = pick(cfg.dirt_negative_duration) & (df.action_type == 'call')
        df.loc[m, 'duration_sec'] = -df.loc[m, 'duration_sec'].abs()
        m = pick(cfg.dirt_unknown_community) & df.community_id.notna()
        df.loc[m, 'community_id'] = 'comm_999'
        print(f'  грязь: +{len(dup)} дублей, всего строк {n} -> {len(df)}')
        return df.sample(frac=1, random_state=cfg.seed).reset_index(drop=True)

    def format_timestamps(self, df: pd.DataFrame) -> pd.DataFrame:
        """Как бывает в жизни: часть источников пишет время по Москве,
        часть — в UTC. Серебряный слой приводит всё к UTC."""
        utc = self.rng.random(len(df)) < self.cfg.dirt_utc_timestamps
        df['timestamp'] = [
            ts.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ') if u
            else ts.strftime('%Y-%m-%d %H:%M:%S%z')
            for ts, u in zip(df.pop('ts'), utc)
        ]
        return df

    # --- запуск ----------------------------------------------------------
    def run(self) -> dict[str, pd.DataFrame]:
        cfg = self.cfg
        print('Генерация синтетических данных…')
        self.build_dictionaries()
        self.assignments = []
        self.simulate_existing_members()
        for i in range(cfg.n_people):
            self.simulate_person(i)
        end = cfg.start + timedelta(days=cfg.enroll_days + cfg.observe_days)
        df = pd.DataFrame(self.events)
        df = df[df.ts < end].sort_values('ts').reset_index(drop=True)
        print(f'  событий без грязи: {len(df)}')
        df = self.add_dirt(df)
        df = self.format_timestamps(df)
        columns = ['event_id', 'event_type', 'timestamp', 'user_id', 'anonymous_id', 'device_id',
                   'platform_id', 'invite_id', 'community_id', 'call_id', 'message_id', 'join_status',
                   'registration_source', 'join_source', 'action_type', 'duration_sec', 'error_type',
                   'leave_reason']
        df = df.reindex(columns=columns)
        df['duration_sec'] = df['duration_sec'].astype('Int64')
        return {
            'bronze_events': df,
            'communities': self.communities.drop(columns='popularity'),
            'invites': self.invites,
            'assignments': pd.DataFrame(self.assignments),
        }


# Распределение часа открытия ссылки: днём меньше, вечером больше.
_hours = np.array([1, 0.5, 0.3, 0.2, 0.2, 0.3, 0.6, 1, 1.4, 1.6, 1.7, 1.8,
                   1.9, 1.9, 1.9, 2, 2.3, 2.8, 3.4, 3.8, 3.9, 3.5, 2.6, 1.7])
HOUR_P = _hours / _hours.sum()


def generate(cfg: Config | None = None, save: bool = True) -> dict[str, pd.DataFrame]:
    cfg = cfg or Config()
    tables = Generator(cfg).run()
    if save:
        cfg.out_dir.mkdir(exist_ok=True)
        for name, df in tables.items():
            df.to_csv(cfg.out_dir / f'{name}.csv', index=False)
        print(f'  сохранено в {cfg.out_dir}/: ' + ', '.join(f'{k}.csv ({len(v)})' for k, v in tables.items()))
    return tables


if __name__ == '__main__':
    generate()
