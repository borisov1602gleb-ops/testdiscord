#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
community_events_synthetic.py

Модуль генерации синтетических данных для платформы тематических
сообществ (каналы, текстовые сообщения, групповые звонки).
Разделы:
    1. Схема событий и контракт данных.
    2. Сборщик событий: логирование по схеме приложения.
    3. Генерация синтетических пользователей и их пути по воронке
       приглашение -> звонок -> регистрация ->
       сообщество -> активация -> возвращение.
    4. Дефекты в сырых данных (бронзовый слой).
    5. Проверка контракта: серебряный слой и карантин.
    6. Золотой слой: воронка, WECU, удержание, ошибки, CAC.
    7. Сохранение CSV и графиков, происхождение данных.

Ключевая гипотеза: если дать возможность присоединиться
к звонку по ссылке без обязательной регистрации, вырастет конверсия из
открытия приглашения в успешное подключение. Поэтому каждый человек при
первом открытии ссылки случайно попадает в группу A (контроль: сначала
регистрация) или B (тест: вход в звонок сразу).

Код использует синтетические данные и не требует внешних файлов.
Все вероятности ниже — допущения модели, а не реальные измерения.

Рекомендуемые библиотеки:
    numpy
    pandas
    matplotlib

Запуск:
    python community_events_synthetic.py
Результат — папка output/ с CSV-файлами и графиками.
"""

import csv
import hashlib
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib

# Если код выполняется без графического интерфейса,
# используем сохранение графиков в файлы.
matplotlib.use("Agg")
import matplotlib.pyplot as plt


# ------------------------------------------------------------------
# Общие настройки
# ------------------------------------------------------------------

SEED = 42
OUTPUT_DIR = Path("output")

# Период эксперимента: 21 день набора и 28 дней наблюдения,
# чтобы досчитать активацию, удержание D7 и когорты за 4 недели.
START = pd.Timestamp("2026-09-07 00:00:00", tz="Europe/Moscow")
ENROLL_DAYS = 21
OBSERVE_DAYS = 28
REFERENCE_TIME = START + pd.Timedelta(days=ENROLL_DAYS + OBSERVE_DAYS)

N_COMMUNITIES = 40
N_NEW_PEOPLE = 20000        # открывают приглашения во время эксперимента
N_EXISTING_MEMBERS = 2500   # уже общаются в сообществах (фон для WECU)

# Порог вовлеченности WECU: >= N сообщений или >= M минут звонков.
WECU_MESSAGES = 5
WECU_CALL_MINUTES = 30

PLATFORMS = ["web", "android", "ios", "desktop"]
PLATFORM_PROBABILITIES = [0.45, 0.30, 0.15, 0.10]

# Каналы привлечения и условная стоимость привлечения: CAC
# считаем по каналам отдельно.
CHANNELS = ["organic", "referral", "ads"]
CHANNEL_PROBABILITIES = [0.50, 0.30, 0.20]
MARKETING_SPEND = {"organic": 0.0, "referral": 60000.0, "ads": 240000.0}


# ------------------------------------------------------------------
# 1. Схема событий и контракт данных
# ------------------------------------------------------------------

# Для каждого события — обязательные поля. Кроме них у любого события
# обязательны event_id, event_type, timestamp и идентификатор человека:
# user_id или anonymous_id.
EVENT_SCHEMA = {
    "invite_link_opened": [
        "invite_id", "community_id", "device_id", "platform_id",
    ],
    "call_joined": [
        "call_id", "community_id", "invite_id", "join_status", "platform_id",
    ],
    "registration_completed": [
        "user_id", "anonymous_id", "registration_source", "invite_id",
        "community_id", "platform_id",
    ],
    "community_joined": [
        "user_id", "community_id", "invite_id", "join_source", "platform_id",
    ],
    "community_interaction": [
        "user_id", "community_id", "action_type", "platform_id",
    ],
    "error_occurred": [
        "error_type", "device_id", "platform_id",
    ],
    "community_left": [
        "user_id", "community_id", "leave_reason", "platform_id",
    ],
}

ALLOWED_EVENT_TYPES = set(EVENT_SCHEMA)

# Поля с ограниченным набором значений (enum).
ENUMS = {
    "action_type": {"message", "call"},
    "join_status": {"success", "failed"},
    "registration_source": {"invite", "after_call"},
    "join_source": {"invite"},
    "leave_reason": {"self", "kicked"},
    "error_type": {"mic_access_denied", "connection_timeout", "invite_expired"},
    "platform_id": set(PLATFORMS),
}

# Все колонки бронзового слоя в одном порядке.
COLUMNS = [
    "event_id", "event_type", "timestamp", "user_id", "anonymous_id",
    "device_id", "platform_id", "invite_id", "community_id", "call_id",
    "message_id", "join_status", "registration_source", "join_source",
    "action_type", "duration_sec", "error_type", "leave_reason",
]

DATA_CONTRACT = {
    "event_id": "обязательное и уникальное поле",
    "timestamp": "обязательное поле, не будущее время, приводится к UTC",
    "user_id / anonymous_id": "хотя бы один идентификатор человека",
    "event_type": "только события из схемы",
    "поля события": "обязательные поля своего типа события заполнены",
    "action_type, join_status и др.": "только допустимые значения",
    "duration_sec": "неотрицательная длительность",
    "invite_id, community_id": "существуют в справочниках",
}

LINEAGE = {
    "app_and_backend (сборщик событий)": ["bronze_events"],
    "bronze_events": ["silver_events", "quarantine_events"],
    "silver_events": ["gold_funnel_ab", "gold_wecu_weekly", "gold_retention",
                      "gold_errors", "dim_user"],
    "dim_user": ["gold_cac_by_channel"],
    "gold_funnel_ab": ["ab_test"],
    "gold_wecu_weekly": ["dashboard_north_star"],
}


def section(title: str) -> None:
    """Печатает заголовок раздела."""
    print("\n" + "=" * 70)
    print(title)
    print("=" * 70)


# ------------------------------------------------------------------
# 2. Сборщик событий
# ------------------------------------------------------------------

class EventCollector:
    """
    Сборщик событий для логирования по схеме приложения.

    Приложение (веб-клиент, сервис звонков, backend) вызывает
    log(event_type, **поля). Сборщик:
        - выдает уникальный event_id и проставляет время;
        - проверяет, что тип события есть в схеме и обязательные поля
          переданы (strict=True — ошибка, иначе предупреждение);
        - копит события в буфере и пачками сбрасывает их в CSV
          бронзового слоя (как это делает очередь событий в продукте).

    В генераторе ниже им же «логируются» синтетические пользователи —
    так синтетика гарантированно соответствует схеме.
    """

    def __init__(self, path=None, buffer_size: int = 5000, strict: bool = True):
        self.path = Path(path) if path else None
        self.buffer_size = buffer_size
        self.strict = strict
        self.buffer = []
        self.events = []
        self.counter = 0
        self.rejected = defaultdict(int)
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "w", newline="", encoding="utf-8") as f:
                csv.DictWriter(f, fieldnames=COLUMNS).writeheader()

    def log(self, event_type: str, timestamp=None, **fields) -> str:
        """Записывает одно событие. Возвращает его event_id."""
        if event_type not in ALLOWED_EVENT_TYPES:
            return self._reject(f"unknown_event_type:{event_type}")
        missing = [f for f in EVENT_SCHEMA[event_type] if fields.get(f) is None]
        if not fields.get("user_id") and not fields.get("anonymous_id"):
            missing.append("user_id|anonymous_id")
        if missing:
            return self._reject(f"{event_type}: нет полей {', '.join(missing)}")
        for field, allowed in ENUMS.items():
            value = fields.get(field)
            if value is not None and value not in allowed:
                return self._reject(f"{event_type}: недопустимое {field}={value}")

        self.counter += 1
        event = {
            "event_id": f"evt_{self.counter:08d}",
            "event_type": event_type,
            "timestamp": timestamp if timestamp is not None else pd.Timestamp.now(tz="Europe/Moscow"),
            **fields,
        }
        self.buffer.append(event)
        if len(self.buffer) >= self.buffer_size:
            self.flush()
        return event["event_id"]

    def _reject(self, reason: str):
        if self.strict:
            raise ValueError(f"Событие не соответствует схеме — {reason}")
        self.rejected[reason] += 1
        return None

    def flush(self) -> None:
        """Сбрасывает буфер: в CSV (если задан путь) и в память."""
        if not self.buffer:
            return
        if self.path:
            with open(self.path, "a", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
                writer.writerows(self.buffer)
        self.events.extend(self.buffer)
        self.buffer = []

    def to_frame(self) -> pd.DataFrame:
        self.flush()
        return pd.DataFrame(self.events).reindex(columns=COLUMNS)


def collector_demo() -> None:
    """Короткая демонстрация: как приложение логирует события."""
    section("2. Сборщик событий: пример логирования из приложения")

    collector = EventCollector(strict=False)
    collector.log(
        "invite_link_opened",
        anonymous_id="anon_demo", device_id="dev_demo", platform_id="web",
        invite_id="inv_demo", community_id="comm_001",
    )
    collector.log(
        "call_joined",
        anonymous_id="anon_demo", call_id="call_demo", community_id="comm_001",
        invite_id="inv_demo", join_status="success", platform_id="web",
    )
    # Ошибочные вызовы: забыли поле и передали недопустимое значение.
    collector.log("community_joined", user_id="u_demo", platform_id="web")
    collector.log(
        "community_interaction",
        user_id="u_demo", community_id="comm_001", action_type="video",
        platform_id="web",
    )

    print(collector.to_frame()[["event_id", "event_type", "anonymous_id", "join_status"]])
    print("\nОтклонено сборщиком:")
    for reason, count in collector.rejected.items():
        print(f"  {reason}: {count}")


# ------------------------------------------------------------------
# 3. Генерация синтетических пользователей
# ------------------------------------------------------------------

# Вероятности пути по воронке (допущения модели).
# Конверсия «открыл приглашение -> подключился к звонку» зависит от
# группы и от того, кем человек был в момент открытия ссылки:
# авторизован или нет, уже в сообществе или нет.
P_CALL_JOIN = {
    ("A", "guest"): 0.30, ("B", "guest"): 0.42,
    ("A", "user"): 0.66, ("B", "user"): 0.67,
    ("A", "member"): 0.80, ("B", "member"): 0.80,
}
P_REGISTER_BEFORE_CALL_A = 0.34   # группа A: гость сначала регистрируется
P_REGISTER_AFTER_CALL_B = 0.70    # группа B: регистрация после звонка
P_JOIN_ERROR = {"A": 0.040, "B": 0.046}
P_COMMUNITY_JOIN = {"A": 0.72, "B": 0.68}
P_ACTIVATION = {"A": 0.62, "B": 0.59}
P_EARLY_LEAVE = {"A": 0.08, "B": 0.095}
P_RETENTION_D7 = {"A": 0.41, "B": 0.39}
P_STAY_NEXT_WEEK = 0.80  # вернувшийся на 2-й неделе остается и дальше
WEEKEND_FACTOR = 0.93  # в выходные до звонка доходят чуть реже

# Час открытия ссылки: вечером чаще.
_hours = np.array([1, 0.5, 0.3, 0.2, 0.2, 0.3, 0.6, 1, 1.4, 1.6, 1.7, 1.8,
                   1.9, 1.9, 1.9, 2, 2.3, 2.8, 3.4, 3.8, 3.9, 3.5, 2.6, 1.7])
HOUR_PROBABILITIES = _hours / _hours.sum()


def assign_group(device_id: str, salt: str = "guest_join_v1") -> str:
    """
    Детерминированное деление 50/50 по хешу устройства:
    один человек всегда в одной группе, сколько бы раз он ни открывал
    ссылку. После регистрации user_id привязывается к этому устройству,
    группа не меняется.
    """
    digest = hashlib.sha256(f"{salt}:{device_id}".encode()).digest()
    return "A" if digest[0] % 2 == 0 else "B"


def generate_dictionaries(rng):
    """Справочники: сообщества и ссылки-приглашения."""
    communities = pd.DataFrame(
        {
            "community_id": [f"comm_{i:03d}" for i in range(1, N_COMMUNITIES + 1)],
            "popularity": rng.lognormal(0, 0.6, N_COMMUNITIES),
        }
    )
    rows = []
    for cid in communities["community_id"]:
        for _ in range(int(rng.integers(2, 9))):
            rows.append(
                {
                    "invite_id": f"inv_{int(rng.integers(0, 16**10)):010x}",
                    "community_id": cid,
                    "created_at": START - pd.Timedelta(days=int(rng.integers(0, 30))),
                }
            )
    return communities, pd.DataFrame(rows)


def log_activity(collector, rng, user, cid, since, days, intensity, platform, device=None):
    """Сообщения и звонки человека в сообществе за период."""
    for d in range(days):
        day = since.normalize() + pd.Timedelta(days=d)
        if day >= REFERENCE_TIME:
            break
        for _ in range(rng.poisson(0.9 * intensity)):
            collector.log(
                "community_interaction",
                timestamp=day + pd.Timedelta(minutes=int(rng.integers(9 * 60, 24 * 60))),
                user_id=user, device_id=device, community_id=cid,
                action_type="message", message_id=f"msg_{collector.counter + 1}",
                platform_id=platform,
            )
        if rng.random() < min(0.6, 0.12 * intensity):
            collector.log(
                "community_interaction",
                timestamp=day + pd.Timedelta(minutes=int(rng.integers(17 * 60, 23 * 60))),
                user_id=user, device_id=device, community_id=cid,
                action_type="call", call_id=f"call_{collector.counter + 1}",
                duration_sec=int(rng.lognormal(np.log(25 * 60), 0.8)),
                platform_id=platform,
            )


def simulate_person(collector, rng, idx, invites, users_rows):
    """Путь одного человека, открывшего ссылку-приглашение."""
    device = f"dev_{idx:06d}"
    anon = f"anon_{idx:06d}"
    group = assign_group(device)
    platform = str(rng.choice(PLATFORMS, p=PLATFORM_PROBABILITIES))
    channel = str(rng.choice(CHANNELS, p=CHANNEL_PROBABILITIES))
    invite = invites.iloc[int(rng.integers(0, len(invites)))]
    cid = invite["community_id"]

    authorized = rng.random() < 0.35
    member = authorized and rng.random() < 0.40
    segment = "member" if member else ("user" if authorized else "guest")
    user = f"user_{idx:06d}" if authorized else None

    day = int(rng.integers(0, ENROLL_DAYS))
    hour = int(rng.choice(24, p=HOUR_PROBABILITIES))
    t = START + pd.Timedelta(days=day, hours=hour, minutes=int(rng.integers(0, 60)))
    weekend = t.dayofweek >= 5

    users_rows.append(
        {
            "device_id": device, "anonymous_id": anon, "user_id_at_open": user,
            "ab_group": group, "segment_at_open": segment,
            "acquisition_channel": channel, "assigned_at": t,
            "community_id": cid, "invite_id": invite["invite_id"],
        }
    )

    common = dict(device_id=device, platform_id=platform,
                  invite_id=invite["invite_id"], community_id=cid)
    collector.log("invite_link_opened", timestamp=t, user_id=user, anonymous_id=anon, **common)

    p_join = P_CALL_JOIN[(group, segment)] * (WEEKEND_FACTOR if weekend else 1.0)
    registered = authorized

    # Группа A: гость сначала регистрируется, только потом идет в звонок.
    if group == "A" and segment == "guest":
        if rng.random() < P_REGISTER_BEFORE_CALL_A:
            t += pd.Timedelta(minutes=int(rng.integers(2, 15)))
            user = f"user_{idx:06d}"
            registered = True
            collector.log("registration_completed", timestamp=t, user_id=user,
                          anonymous_id=anon, registration_source="invite", **common)
            p_join = min(0.99, p_join / P_REGISTER_BEFORE_CALL_A)
        else:
            p_join = 0.0

    joined = rng.random() < p_join
    attempted = joined or (p_join > 0 and rng.random() < 0.35)
    if attempted:
        t += pd.Timedelta(minutes=int(rng.integers(1, 6)))
        if rng.random() < P_JOIN_ERROR[group]:
            collector.log("error_occurred", timestamp=t, user_id=user, anonymous_id=anon,
                          device_id=device, platform_id=platform,
                          error_type=str(rng.choice(["mic_access_denied", "connection_timeout"])))
        collector.log("call_joined", timestamp=t, user_id=user, anonymous_id=anon,
                      call_id=f"call_{collector.counter + 1}",
                      join_status="success" if joined else "failed", **common)
    if not joined:
        return

    t += pd.Timedelta(minutes=max(1, int(rng.lognormal(np.log(22), 0.7))))

    # Группа B: гость после звонка может зарегистрироваться.
    if not registered:
        if rng.random() >= P_REGISTER_AFTER_CALL_B:
            return
        t += pd.Timedelta(minutes=int(rng.integers(1, 20)))
        user = f"user_{idx:06d}"
        collector.log("registration_completed", timestamp=t, user_id=user,
                      anonymous_id=anon, registration_source="after_call", **common)

    if member:
        log_activity(collector, rng, user, cid, t, 14, rng.gamma(1.5, 1.0), platform, device)
        return
    if rng.random() >= P_COMMUNITY_JOIN[group]:
        return
    t += pd.Timedelta(minutes=int(rng.integers(1, 30)))
    collector.log("community_joined", timestamp=t, user_id=user, community_id=cid,
                  invite_id=invite["invite_id"], join_source="invite",
                  platform_id=platform, device_id=device)

    # Ранний выход в течение K = 7 дней.
    if rng.random() < P_EARLY_LEAVE[group]:
        collector.log("community_left", timestamp=t + pd.Timedelta(days=float(rng.uniform(0.2, 7))),
                      user_id=user, community_id=cid, platform_id=platform,
                      leave_reason=str(rng.choice(["self", "kicked"], p=[0.85, 0.15])))
        return
    # Активация: значимое действие в первые дни после вступления.
    if rng.random() < P_ACTIVATION[group]:
        log_activity(collector, rng, user, cid, t, 3, rng.gamma(1.6, 1.0), platform, device)
    # Удержание D7: снова пришел в то же сообщество на 7–13 день;
    # дальше каждую неделю остается с вероятностью P_STAY_NEXT_WEEK.
    if rng.random() < P_RETENTION_D7[group]:
        intensity = rng.gamma(1.4, 1.0)
        week = 1
        while week <= 4:
            log_activity(collector, rng, user, cid, t + pd.Timedelta(days=7 * week), 7,
                         intensity, platform, device)
            if rng.random() >= P_STAY_NEXT_WEEK:
                break
            week += 1


def generate_synthetic_events(seed: int = SEED):
    """
    Генерирует сырые события через сборщик.

    Возвращает:
        events: бронзовые события без дефектов;
        users: участники эксперимента (группа, сегмент, канал);
        communities, invites: справочники.
    """
    rng = np.random.default_rng(seed)
    communities, invites = generate_dictionaries(rng)
    collector = EventCollector(strict=True)

    # Фон: старожилы сообществ общаются весь период.
    weights = communities["popularity"] / communities["popularity"].sum()
    for i in range(N_EXISTING_MEMBERS):
        cid = rng.choice(communities["community_id"], p=weights)
        log_activity(collector, rng, f"user_old_{i:05d}", cid, START,
                     ENROLL_DAYS + OBSERVE_DAYS, rng.gamma(1.2, 1.0),
                     str(rng.choice(PLATFORMS, p=PLATFORM_PROBABILITIES)))

    users_rows = []
    for idx in range(N_NEW_PEOPLE):
        simulate_person(collector, rng, idx, invites, users_rows)

    events = collector.to_frame()
    events = events[events["timestamp"] < REFERENCE_TIME].reset_index(drop=True)
    return events, pd.DataFrame(users_rows), communities, invites, rng


# ------------------------------------------------------------------
# 4. Дефекты в сырых данных
# ------------------------------------------------------------------

def add_defects(df: pd.DataFrame, rng) -> pd.DataFrame:
    """
    Добавляет типичные дефекты сырых данных:
        - дубли событий (повторная отправка из приложения);
        - пропущенные event_id и идентификаторы человека;
        - недопустимые значения action_type и join_status;
        - будущие метки времени;
        - отрицательная длительность звонка;
        - неизвестные сообщества;
        - часть времени в UTC, часть по Москве.
    """
    df = df.copy()
    n = len(df)

    def pick(share):
        return rng.choice(n, size=int(n * share), replace=False)

    df.loc[pick(0.001), "event_id"] = None
    df.loc[pick(0.003), ["user_id", "anonymous_id"]] = None

    idx = df.index[df["event_type"] == "community_interaction"]
    bad = rng.choice(idx, size=int(len(idx) * 0.002), replace=False)
    df.loc[bad, "action_type"] = rng.choice(["2", "video", "MSG"], size=bad.size)

    idx = df.index[df["event_type"] == "call_joined"]
    bad = rng.choice(idx, size=int(len(idx) * 0.003), replace=False)
    df.loc[bad, "join_status"] = "ok"

    idx = df.index[df["duration_sec"].notna()]
    bad = rng.choice(idx, size=int(len(idx) * 0.002), replace=False)
    df.loc[bad, "duration_sec"] = -df.loc[bad, "duration_sec"]

    idx = df.index[df["community_id"].notna()]
    bad = rng.choice(idx, size=int(len(idx) * 0.002), replace=False)
    df.loc[bad, "community_id"] = "comm_999"

    future = pick(0.001)
    df.loc[future, "timestamp"] = [
        REFERENCE_TIME + pd.Timedelta(hours=int(h)) for h in rng.integers(1, 72, future.size)
    ]

    # Дубли: те же строки с тем же event_id.
    duplicates = df.iloc[pick(0.015)]
    df = pd.concat([df, duplicates], ignore_index=True)

    # Время строкой: часть источников пишет по Москве, часть — в UTC.
    utc = rng.random(len(df)) < 0.30
    df["timestamp"] = [
        ts.tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ") if u
        else ts.strftime("%Y-%m-%d %H:%M:%S%z")
        for ts, u in zip(df["timestamp"], utc)
    ]
    df["duration_sec"] = df["duration_sec"].astype("Int64")
    return df.sample(frac=1, random_state=SEED).reset_index(drop=True)


# ------------------------------------------------------------------
# 5. Контракт данных: серебряный слой и карантин
# ------------------------------------------------------------------

def validate_data_contract(df: pd.DataFrame, communities, invites):
    """
    Проверяет события по контракту данных.

    Возвращает:
        valid_mask: маска годных строк;
        checks: таблица отдельных проверок (True — проверка пройдена).
    """
    checks = pd.DataFrame(index=df.index)
    ts = pd.to_datetime(df["timestamp"], utc=True, format="mixed")

    checks["event_id_not_null"] = df["event_id"].notna()
    checks["event_id_unique"] = ~df["event_id"].duplicated(keep="first") | df["event_id"].isna()
    checks["person_id_not_null"] = df["user_id"].notna() | df["anonymous_id"].notna()
    checks["event_type_allowed"] = df["event_type"].isin(ALLOWED_EVENT_TYPES)
    checks["timestamp_not_future"] = ts <= REFERENCE_TIME.tz_convert("UTC")

    required_ok = pd.Series(True, index=df.index)
    for event_type, fields in EVENT_SCHEMA.items():
        is_type = df["event_type"] == event_type
        for field in fields:
            required_ok &= ~(is_type & df[field].isna())
    checks["required_fields_present"] = required_ok

    enums_ok = pd.Series(True, index=df.index)
    for field, allowed in ENUMS.items():
        enums_ok &= df[field].isna() | df[field].isin(allowed)
    checks["enum_values_allowed"] = enums_ok

    checks["duration_non_negative"] = df["duration_sec"].isna() | (df["duration_sec"] >= 0)
    checks["community_in_dictionary"] = (
        df["community_id"].isna() | df["community_id"].isin(communities["community_id"])
    )
    checks["invite_in_dictionary"] = df["invite_id"].isna() | df["invite_id"].isin(invites["invite_id"])

    return checks.all(axis=1), checks


def data_quality_report(checks: pd.DataFrame) -> pd.DataFrame:
    """Формирует отчет по качеству данных."""
    report = pd.DataFrame(
        {
            "проверка": checks.columns,
            "ошибок": (~checks).sum().astype(int).to_numpy(),
            "доля_ошибок": (~checks).mean().to_numpy(),
        }
    )
    return report.sort_values("доля_ошибок", ascending=False).reset_index(drop=True)


def build_silver(raw: pd.DataFrame, valid_mask: pd.Series) -> pd.DataFrame:
    """
    Серебряный слой: годные события, единое время UTC и склейка
    anonymous_id -> user_id после регистрации (один человек — один person_id).
    """
    silver = raw[valid_mask].copy()
    silver["timestamp_utc"] = pd.to_datetime(silver.pop("timestamp"), utc=True, format="mixed")

    links = silver[silver["event_type"] == "registration_completed"][["anonymous_id", "user_id"]]
    anon_to_user = dict(links.drop_duplicates("anonymous_id").itertuples(index=False))
    silver["person_id"] = (
        silver["user_id"]
        .fillna(silver["anonymous_id"].map(anon_to_user))
        .fillna(silver["anonymous_id"])
    )
    return silver.sort_values("timestamp_utc").reset_index(drop=True)


def plot_quality_report(report: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=(9, 4))
    ax.bar(report["проверка"], report["доля_ошибок"])
    ax.set_ylabel("Доля ошибочных строк")
    ax.set_title("Качество данных: контракт событий")
    plt.xticks(rotation=25, ha="right")
    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / "data_quality.png", dpi=150)
    plt.close(fig)
    print("Сохранен файл: output/data_quality.png")


# ------------------------------------------------------------------
# 6. Золотой слой
# ------------------------------------------------------------------

def build_person_table(silver: pd.DataFrame, users: pd.DataFrame) -> pd.DataFrame:
    """
    Одна строка на участника эксперимента: группа, сегмент, канал и
    прошел ли он каждый шаг воронки и защитные метрики.
    """
    people = users.copy()
    links = silver[silver["event_type"] == "registration_completed"][["anonymous_id", "user_id"]]
    people = people.merge(links.drop_duplicates("anonymous_id"), on="anonymous_id", how="left")
    people["person_id"] = (
        people["user_id_at_open"].fillna(people["user_id"]).fillna(people["anonymous_id"])
    )
    people = people.set_index("person_id")

    def first(event_type, condition=None):
        part = silver[silver["event_type"] == event_type]
        if condition is not None:
            part = part[condition(part)]
        return part.groupby("person_id")["timestamp_utc"].min()

    people["opened_invite"] = people.index.isin(first("invite_link_opened").index)
    people["call_joined"] = people.index.isin(
        first("call_joined", lambda p: p["join_status"] == "success").index
    )
    attempts = silver[silver["event_type"] == "call_joined"].groupby("person_id").size()
    errors = silver[silver["event_type"] == "error_occurred"].groupby("person_id").size()
    people["call_attempts"] = attempts.reindex(people.index).fillna(0).astype(int)
    people["join_errors"] = errors.reindex(people.index).fillna(0).astype(int)
    people["new_registration"] = people.index.isin(first("registration_completed").index)

    joined = silver[silver["event_type"] == "community_joined"].groupby("person_id")["timestamp_utc"].min()
    people["joined_at"] = joined.reindex(people.index)
    people["community_joined"] = people["joined_at"].notna()
    people["left_at"] = first("community_left").reindex(people.index)

    inter = silver[silver["event_type"] == "community_interaction"][["person_id", "timestamp_utc"]]
    inter = inter.merge(people[["joined_at"]].dropna(), left_on="person_id", right_index=True)
    days_after = (inter["timestamp_utc"] - inter["joined_at"]).dt.total_seconds() / 86400
    activated = inter.loc[(days_after >= 0) & (days_after <= 7), "person_id"].unique()
    returned = inter.loc[(days_after >= 7) & (days_after < 14), "person_id"].unique()

    is_joined = people["community_joined"]
    people["activated"] = np.where(is_joined, people.index.isin(activated), np.nan)
    people["retained_d7"] = np.where(is_joined, people.index.isin(returned), np.nan)
    left_days = (people["left_at"] - people["joined_at"]).dt.total_seconds() / 86400
    people["left_early"] = np.where(is_joined, (left_days <= 7).fillna(False), np.nan)
    return people.reset_index()


def funnel_by_group(people: pd.DataFrame) -> pd.DataFrame:
    """Воронка нового пользователя по группам A/B."""
    g = people[people["opened_invite"]].groupby("ab_group")
    funnel = pd.DataFrame(
        {
            "открыли_приглашение": g["opened_invite"].sum(),
            "подключились_к_звонку": g["call_joined"].sum(),
            "зарегистрировались": g["new_registration"].sum(),
            "вступили_в_сообщество": g["community_joined"].sum(),
            "активировались": g["activated"].sum(),
            "вернулись_D7": g["retained_d7"].sum(),
        }
    )
    funnel["конверсия_в_звонок"] = funnel["подключились_к_звонку"] / funnel["открыли_приглашение"]
    return funnel


def guardrails_by_group(people: pd.DataFrame) -> pd.DataFrame:
    """Защитные метрики: активация, ранний выход, удержание, ошибки."""
    joined = people[people["community_joined"]].groupby("ab_group")
    out = pd.DataFrame(
        {
            "activation_rate": joined["activated"].mean(),
            "early_leave_rate": joined["left_early"].mean(),
            "retention_d7": joined["retained_d7"].mean(),
        }
    )
    errors = people.groupby("ab_group")[["join_errors", "call_attempts"]].sum()
    out["tech_error_rate"] = errors["join_errors"] / errors["call_attempts"]
    return out


def wecu_weekly(silver: pd.DataFrame) -> pd.DataFrame:
    """WECU: уникальные люди за неделю с >= N сообщений или >= M минут звонков."""
    it = silver[silver["event_type"] == "community_interaction"].copy()
    local = it["timestamp_utc"].dt.tz_convert("Europe/Moscow").dt.tz_localize(None)
    it["week"] = local.dt.to_period("W-SUN").dt.start_time.dt.date
    it["is_message"] = it["action_type"] == "message"
    it["call_minutes"] = np.where(it["action_type"] == "call", it["duration_sec"].fillna(0) / 60, 0)
    per_user = it.groupby(["week", "person_id"]).agg(
        messages=("is_message", "sum"), call_minutes=("call_minutes", "sum")
    )
    per_user["engaged"] = (
        (per_user["messages"] >= WECU_MESSAGES) | (per_user["call_minutes"] >= WECU_CALL_MINUTES)
    )
    return per_user.groupby("week").agg(
        активных=("engaged", "size"), WECU=("engaged", "sum"),
        сообщений=("messages", "sum"), минут_звонков=("call_minutes", "sum"),
    ).round(0)


def retention_by_cohort(silver: pd.DataFrame, people: pd.DataFrame) -> pd.DataFrame:
    """
    Когортное удержание: когорта — неделя вступления в
    сообщество, значение — доля активных в каждую следующую неделю.
    """
    joined = people[people["community_joined"]][["person_id", "joined_at"]]
    joined["cohort_week"] = ((joined["joined_at"] - START.tz_convert("UTC")).dt.days // 7) + 1
    it = silver[silver["event_type"] == "community_interaction"][["person_id", "timestamp_utc"]]
    it = it.merge(joined, on="person_id")
    it["week_rel"] = ((it["timestamp_utc"] - it["joined_at"]).dt.days // 7)
    it = it[(it["week_rel"] >= 0) & (it["week_rel"] <= 3)]
    active = it.groupby(["cohort_week", "week_rel"])["person_id"].nunique().unstack(fill_value=0)
    size = joined.groupby("cohort_week").size()
    # Только полные когорты: за каждой можно наблюдать все 4 недели.
    full = [c for c in size.index if START + pd.Timedelta(weeks=int(c) + 4) <= REFERENCE_TIME]
    return active.div(size, axis=0).loc[full]


def cac_by_channel(people: pd.DataFrame) -> pd.DataFrame:
    """
    CAC по каналам привлечения: расходы / новые пользователи.
    Новый пользователь — тот, кто впервые зарегистрировался за период.
    """
    new_users = people[people["new_registration"]].groupby("acquisition_channel").size()
    cac = pd.DataFrame(
        {
            "новых_пользователей": new_users,
            "расходы": pd.Series(MARKETING_SPEND),
        }
    )
    cac["CAC"] = cac["расходы"] / cac["новых_пользователей"]
    return cac


def plot_gold(funnel, wecu, retention) -> None:
    """Графики золотого слоя."""
    steps = funnel.columns[:-1]
    fig, ax = plt.subplots(figsize=(10, 4))
    x = np.arange(len(steps))
    for i, group in enumerate(funnel.index):
        share = funnel.loc[group, steps] / funnel.loc[group, steps[0]]
        ax.bar(x + (i - 0.5) * 0.4, share, width=0.4, label=f"Группа {group}")
    ax.set_xticks(x)
    ax.set_xticklabels([s.replace("_", " ") for s in steps], rotation=15, ha="right")
    ax.set_ylabel("Доля от открывших приглашение")
    ax.set_title("Воронка по группам A/B")
    ax.legend()
    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / "funnel_ab.png", dpi=150)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(9, 4))
    ax.plot([str(w) for w in wecu.index], wecu["WECU"], marker="o", label="WECU")
    ax.plot([str(w) for w in wecu.index], wecu["активных"], marker="x", linestyle="--", label="Активных за неделю")
    ax.set_ylabel("Пользователей")
    ax.set_title("North Star: WECU по неделям")
    ax.legend()
    plt.xticks(rotation=20, ha="right")
    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / "wecu_weekly.png", dpi=150)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(8, 4))
    im = ax.imshow(retention.values, aspect="auto", cmap="viridis")
    ax.set_xticks(range(retention.shape[1]))
    ax.set_xticklabels(retention.columns)
    ax.set_yticks(range(retention.shape[0]))
    ax.set_yticklabels(retention.index)
    ax.set_xlabel("Неделя после вступления")
    ax.set_ylabel("Когорта (неделя вступления)")
    ax.set_title("Когортное удержание в сообществе")
    fig.colorbar(im, ax=ax, label="Доля активных")
    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / "retention_heatmap.png", dpi=150)
    plt.close(fig)
    print("Сохранены файлы: output/funnel_ab.png, output/wecu_weekly.png, output/retention_heatmap.png")


# ------------------------------------------------------------------
# 7. Происхождение данных
# ------------------------------------------------------------------

def print_lineage() -> None:
    for target, sources in LINEAGE.items():
        print(f"{target} -> {', '.join(sources)}")


# ------------------------------------------------------------------
# Главная функция
# ------------------------------------------------------------------

def main() -> None:
    """Генерация синтетики, проверка качества и витрины."""
    print("Синтетические данные платформы тематических сообществ")
    OUTPUT_DIR.mkdir(exist_ok=True)

    section("1. Контракт данных")
    for field, rule in DATA_CONTRACT.items():
        print(f"{field}: {rule}")

    collector_demo()

    section("3. Генерация синтетических событий")
    events, users, communities, invites, rng = generate_synthetic_events()
    print(f"Сообществ: {len(communities)}, ссылок-приглашений: {len(invites)}")
    print(f"Участников эксперимента: {len(users)}  (группа A: {(users['ab_group'] == 'A').sum()}, "
          f"B: {(users['ab_group'] == 'B').sum()})")
    print(f"Событий без дефектов: {len(events)}")
    print(events["event_type"].value_counts())

    section("4. Сырые события с дефектами (бронзовый слой)")
    raw = add_defects(events, rng)
    print(raw.head(8))
    print(f"Всего сырых событий: {len(raw)}")

    section("5. Качество данных: серебряный слой и карантин")
    valid_mask, checks = validate_data_contract(raw, communities, invites)
    report = data_quality_report(checks)
    print(report.to_string(index=False, float_format="{:.4f}".format))
    plot_quality_report(report)
    silver = build_silver(raw, valid_mask)
    quarantine = raw[~valid_mask].copy()
    quarantine["причина"] = checks[~valid_mask].apply(lambda r: ", ".join(r.index[~r]), axis=1)
    print(f"Годных событий: {len(silver)}")
    print(f"Событий в карантине: {len(quarantine)}")

    section("6. Золотой слой")
    people = build_person_table(silver, users)
    funnel = funnel_by_group(people)
    guards = guardrails_by_group(people)
    wecu = wecu_weekly(silver)
    retention = retention_by_cohort(silver, people)
    cac = cac_by_channel(people)
    print("Воронка по группам A/B:")
    print(funnel.to_string(float_format="{:.3f}".format))
    print("\nЗащитные метрики:")
    print(guards.round(4))
    print("\nWECU по неделям:")
    print(wecu)
    print("\nКогортное удержание:")
    print(retention.round(3))
    print("\nCAC по каналам привлечения:")
    print(cac.round(2))
    plot_gold(funnel, wecu, retention)

    section("7. Сохранение CSV")
    files = {
        "bronze_events.csv": raw,
        "silver_events.csv": silver,
        "quarantine_events.csv": quarantine,
        "experiment_users.csv": people,
        "dim_communities.csv": communities.drop(columns="popularity"),
        "dim_invites.csv": invites,
        "gold_funnel_ab.csv": funnel,
        "gold_guardrails_ab.csv": guards,
        "gold_wecu_weekly.csv": wecu,
        "gold_retention_cohorts.csv": retention,
        "gold_cac_by_channel.csv": cac,
        "data_quality_report.csv": report,
    }
    for name, df in files.items():
        df.to_csv(OUTPUT_DIR / name, index=name.startswith("gold_"))
        print(f"Сохранен файл: output/{name} ({len(df)} строк)")

    section("Происхождение данных")
    print_lineage()

    section("Завершение")
    print("Синтетические данные готовы. Главная таблица для эксперимента "
          "output/experiment_users.csv — одна строка на "
          "участника с группой A/B, сегментом и шагами воронки.")


if __name__ == "__main__":
    main()
