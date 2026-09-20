// Экран звонка: подключение к комнате LiveKit, плитки участников, микрофон,
// камера, демонстрация экрана и выход с подсчётом длительности.
// Если сервер звонков недоступен, экран честно это показывает и всё равно
// корректно завершает участие — иначе время в базе осталось бы несосчитанным.
import { api } from '../api.js';
import { store } from '../store.js';
import { el, mount, icon, initial } from '../dom.js';
import { navigate } from '../router.js';
import { showInviteModal } from './home.js';

const STATUS_TEXT = {
  connecting: 'Подключаемся…',
  connected: 'В звонке',
  failed: 'Нет связи',
};

const QUALITY_TEXT = {
  excellent: 'связь отличная',
  good: 'связь хорошая',
  poor: 'связь слабая',
  lost: 'связь потеряна',
  unknown: '',
};

export async function renderCall(callId) {
  const active = store.activeCall;
  if (!active || active.callId !== callId) {
    return mount(
      el('div', { class: 'summary' }, [
        el('div', { class: 'summary-card' }, [
          el('h1', { class: 'summary-title', text: 'Звонок недоступен' }),
          el('p', {
            class: 'summary-time',
            text: 'Подключитесь к звонку заново из канала или по приглашению',
          }),
          el('div', { class: 'invite-actions' }, [
            el('button', {
              class: 'btn btn-primary btn-block',
              type: 'button',
              text: 'На главную',
              onclick: () => navigate('#/'),
            }),
          ]),
        ]),
      ]),
    );
  }

  // Живёт вне #app: перерисовка экрана не должна прерывать воспроизведение.
  document.getElementById('audio-sink')?.remove();
  const audioSink = el('div', { id: 'audio-sink', style: 'display:none' });
  document.body.append(audioSink);

  // В звонке место ограничено, поэтому от почты показываем часть до собаки.
  const shortName = (value) => (value ?? '').split('@')[0] || 'Гость';
  const selfName = shortName(store.user?.email) || 'Гость';
  const startedAt = Date.now();

  let room = null;
  let livekit = null;
  let status = 'connecting';
  let statusDetail = '';
  let quality = 'unknown';
  let muted = false;
  let cameraOn = false;
  let sharing = false;
  let micAvailable = true;
  let leaving = false;
  let busyControl = null;
  let share = null; // { track, name } — чужая или своя демонстрация
  let participants = [{ id: 'local', name: selfName, local: true, speaking: false, muted: false }];

  // Имя в звонке: почта у зарегистрированного, «Гость» у пришедшего по ссылке.
  // Идентификатор — это UUID, показывать его человеку бессмысленно.
  const displayName = (name) => (!name || name === 'guest' ? 'Гость' : shortName(name));

  async function connect() {
    try {
      livekit = await import('/vendor/livekit-client.esm.mjs');
      const { Room, RoomEvent } = livekit;
      room = new Room();

      for (const event of [
        RoomEvent.ParticipantConnected,
        RoomEvent.ParticipantDisconnected,
        RoomEvent.ActiveSpeakersChanged,
        RoomEvent.TrackMuted,
        RoomEvent.TrackUnmuted,
        RoomEvent.TrackPublished,
        RoomEvent.TrackUnpublished,
        RoomEvent.LocalTrackPublished,
        RoomEvent.LocalTrackUnpublished,
      ]) {
        room.on(event, sync);
      }

      room.on(RoomEvent.ConnectionQualityChanged, (value, participant) => {
        if (participant?.isLocal) {
          quality = value;
          draw();
        }
      });

      room.on(RoomEvent.TrackSubscribed, (track) => {
        // Элементы с аудио должны жить в DOM: открепление от документа
        // делает воспроизведение ненадёжным.
        if (track.kind === 'audio') {
          const audio = track.attach();
          audio.autoplay = true;
          audioSink.append(audio);
        }
        sync();
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((element) => element.remove());
        sync();
      });

      room.on(RoomEvent.Disconnected, () => {
        if (leaving) return;
        status = 'failed';
        statusDetail = 'Соединение со звонком прервано';
        draw();
      });

      await room.connect(active.url, active.token);
      status = 'connected';

      try {
        await room.localParticipant.setMicrophoneEnabled(true);
      } catch {
        micAvailable = false;
        statusDetail = 'Микрофон недоступен — вы слышите других, но говорить не можете';
      }
      sync();
    } catch (err) {
      // Звонковый сервер может быть не поднят: участие всё равно записано
      // в БД, поэтому корректный выход из звонка обязан работать и здесь.
      console.error('livekit:', err);
      status = 'failed';
      statusDetail = 'Не удалось подключиться к серверу звонков';
      draw();
    }
  }

  function micPublication(participant) {
    return participant?.getTrackPublication?.(livekit.Track.Source.Microphone);
  }

  function cameraTrack(participant) {
    const publication = participant?.getTrackPublication?.(livekit.Track.Source.Camera);
    return publication?.isMuted ? null : (publication?.track ?? null);
  }

  function screenTrack(participant) {
    const publication = participant?.getTrackPublication?.(livekit.Track.Source.ScreenShare);
    return publication?.track ?? null;
  }

  // Состояние экрана целиком выводится из состояния комнаты: так оно не
  // разъезжается с тем, что реально происходит в звонке.
  function sync() {
    const local = room?.localParticipant;
    const remotes = room ? [...room.remoteParticipants.values()] : [];

    participants = [
      {
        id: 'local',
        name: selfName,
        local: true,
        speaking: Boolean(local?.isSpeaking),
        muted,
        video: cameraTrack(local),
      },
      ...remotes.map((p) => {
        // isMicrophoneEnabled возвращает true, когда публикации нет вовсе,
        // поэтому состояние читаем с самой публикации дорожки.
        const publication = micPublication(p);
        return {
          id: p.identity,
          name: displayName(p.name),
          local: false,
          speaking: p.isSpeaking,
          muted: !publication || publication.isMuted,
          video: cameraTrack(p),
        };
      }),
    ];

    const localShare = screenTrack(local);
    const remoteSharer = remotes.find((p) => screenTrack(p));
    if (localShare) share = { track: localShare, name: 'Вы показываете экран' };
    else if (remoteSharer) {
      share = { track: screenTrack(remoteSharer), name: `${displayName(remoteSharer.name)} показывает экран` };
    } else share = null;

    sharing = Boolean(localShare);
    draw();
  }

  async function withControl(name, action) {
    busyControl = name;
    draw();
    try {
      await action();
    } catch (err) {
      console.error(`${name}:`, err);
      if (name === 'mic') micAvailable = false;
      if (name === 'share') statusDetail = 'Не удалось начать демонстрацию экрана';
      if (name === 'camera') statusDetail = 'Камера недоступна';
    } finally {
      busyControl = null;
      sync();
    }
  }

  function toggleMute() {
    muted = !muted;
    // Интерфейс реагирует сразу, не дожидаясь ответа SDK.
    draw();
    return withControl('mic', () => room?.localParticipant.setMicrophoneEnabled(!muted));
  }

  function toggleCamera() {
    cameraOn = !cameraOn;
    draw();
    return withControl('camera', () => room?.localParticipant.setCameraEnabled(cameraOn));
  }

  function toggleShare() {
    const next = !sharing;
    return withControl('share', async () => {
      await room?.localParticipant.setScreenShareEnabled(next, { audio: true });
    });
  }

  async function leave() {
    leaving = true;
    draw();
    try {
      await room?.disconnect();
    } catch {
      /* соединения могло и не быть */
    }
    audioSink.remove();
    try {
      const result = await api(`/calls/${callId}/leave`, {
        method: 'POST',
        auth: store.isAuthenticated,
        body: store.isAuthenticated ? {} : { anonymous_id: store.anonymousId },
      });
      store.activeCall = null;
      showSummary(result.participant.duration_sec);
    } catch (err) {
      store.activeCall = null;
      showSummary(null, err.message);
    }
  }

  function showSummary(durationSec, error) {
    clearInterval(timerId);
    const guestInvite = active.guest ? active.inviteId : null;
    mount(
      el('div', { class: 'summary' }, [
        el('div', { class: 'summary-card' }, [
          el('h1', { class: 'summary-title', text: 'Звонок завершён' }),
          el('p', {
            class: 'summary-time',
            text:
              durationSec != null ? `Вы были в звонке ${formatDuration(durationSec)}` : (error ?? ''),
          }),
          guestInvite &&
            el('p', {
              class: 'promo',
              text: 'Зарегистрируйтесь, чтобы остаться в сообществе и писать в чат',
            }),
          el('div', { class: 'invite-actions' }, [
            guestInvite
              ? el('button', {
                  class: 'btn btn-primary btn-lg btn-block',
                  type: 'button',
                  text: 'Зарегистрироваться',
                  onclick: () => {
                    store.pendingInvite = guestInvite;
                    navigate('#/login');
                  },
                })
              : el('button', {
                  class: 'btn btn-primary btn-lg btn-block',
                  type: 'button',
                  text: 'Вернуться в канал',
                  onclick: () => navigate(active.communityId ? `#/c/${active.communityId}` : '#/'),
                }),
            guestInvite &&
              el('button', {
                class: 'btn btn-secondary btn-block',
                type: 'button',
                text: 'Вернуться к приглашению',
                onclick: () => navigate(`#/invite/${guestInvite}`),
              }),
          ]),
        ]),
      ]),
    );
  }

  function formatDuration(sec) {
    const minutes = Math.floor(sec / 60);
    const seconds = sec % 60;
    return minutes > 0 ? `${minutes} мин ${seconds} сек` : `${seconds} сек`;
  }

  function formatTimer(sec) {
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  // ===== разметка =====
  // Узлы создаются один раз: состояние звонка меняется часто, а полная
  // перерисовка теряла бы нажатия и обрывала воспроизведение видео.

  const channelLabel = el('span', { class: 'call-channel', text: active.channelName ?? 'Звонок' });
  const metaLabel = el('span', { class: 'call-meta' });
  const qualityLabel = el('span');
  const statusLabel = document.createTextNode('');
  const statusNode = el('span', { class: 'status' }, [el('span', { class: 'dot' }), statusLabel]);
  const bannerNode = el('div', { class: 'banner' }, [icon('alert'), document.createTextNode('')]);
  const shareSlot = el('div', { class: 'share-slot' });
  const membersNode = el('div', { class: 'members' });
  const hintNode = el('p', { class: 'call-hint' });
  const sideList = el('div', { class: 'side-list' });

  const micButton = el('button', { class: 'ctl', type: 'button', title: 'Микрофон', onclick: toggleMute });
  const cameraButton = el('button', { class: 'ctl', type: 'button', title: 'Камера', onclick: toggleCamera });
  const shareButton = el('button', {
    class: 'ctl',
    type: 'button',
    title: 'Демонстрация экрана',
    onclick: toggleShare,
  });
  const peopleButton = el('button', {
    class: 'ctl',
    type: 'button',
    title: 'Участники',
    onclick: () => screen.classList.toggle('show-side'),
  });
  const hangButton = el('button', { class: 'hang', type: 'button', title: 'Выйти из звонка', onclick: leave });

  const body = el('div', { class: 'call-body' }, [
    shareSlot,
    membersNode,
    active.guest &&
      el('p', {
        class: 'guest-note',
        text: 'Вы в звонке как гость — после выхода можно зарегистрироваться и остаться в сообществе',
      }),
  ]);

  const screen = el('div', { class: 'call' }, [
    el('div', { class: 'call-stage' }, [
      el('header', { class: 'call-head' }, [
        icon('speaker', 16),
        channelLabel,
        el('span', { class: 'call-sep' }),
        metaLabel,
        el('div', { class: 'call-quality' }, [statusNode, icon('wifi', 14), qualityLabel]),
      ]),
      body,
      el('footer', { class: 'call-foot' }, [
        micButton,
        cameraButton,
        shareButton,
        peopleButton,
        el('span', { class: 'ctl-sep' }),
        hangButton,
        hintNode,
      ]),
    ]),
    el('aside', { class: 'call-side' }, [
      el('div', { class: 'side-kicker', text: 'В звонке' }),
      sideList,
      el('div', { class: 'side-kicker', text: 'Канал' }),
      el('p', {
        class: 'side-note',
        text: active.communityName
          ? `Сообщество «${active.communityName}». Запись не ведётся.`
          : 'Запись не ведётся.',
      }),
      !active.guest &&
        active.communityId &&
        el(
          'button',
          {
            class: 'btn btn-secondary btn-block',
            type: 'button',
            style: 'margin-top:auto',
            onclick: () => showInviteModal(active.communityId),
          },
          [icon('link', 15), 'Пригласить'],
        ),
    ]),
  ]);

  // Плитки живут между перерисовками и обновляются на месте: пересоздание
  // каждую секунду перезапускало бы видео участника.
  const tiles = new Map();

  function createTile() {
    const avatar = el('div', { class: 'avatar' });
    const nameLabel = el('span', { class: 'rail-name' });
    const stateNode = el('span', { class: 'member-state' });
    const bars = el('div', { class: 'bars' }, [el('span'), el('span'), el('span'), el('span')]);
    const micSlot = el('span', { class: 'member-mic' });
    const node = el('div', { class: 'member' }, [
      avatar,
      el('div', { class: 'member-name' }, [nameLabel]),
      stateNode,
      micSlot,
    ]);
    return { node, avatar, nameLabel, stateNode, bars, micSlot, trackSid: null, muted: null };
  }

  function updateTile(tile, p) {
    tile.node.className = `member${p.speaking && !p.muted ? ' is-speaking' : ''}${
      p.muted ? ' is-muted' : ''
    }${p.video ? ' has-video' : ''}`;

    const sid = p.video?.sid ?? null;
    if (sid !== tile.trackSid) {
      tile.node.querySelector('video')?.remove();
      if (p.video) {
        const video = p.video.attach();
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        tile.node.prepend(video);
      }
      tile.trackSid = sid;
    }

    tile.avatar.textContent = initial(p.name);
    tile.nameLabel.textContent = p.local ? 'Вы' : p.name;

    const speaking = p.speaking && !p.muted;
    if (speaking && !tile.bars.isConnected) tile.stateNode.replaceWith(tile.bars);
    if (!speaking && !tile.stateNode.isConnected) tile.bars.replaceWith(tile.stateNode);
    tile.stateNode.textContent = p.muted ? 'микрофон выключен' : 'слушает';

    if (tile.muted !== p.muted) {
      tile.micSlot.replaceChildren(icon(p.muted ? 'micOff' : 'mic', 16));
      tile.muted = p.muted;
    }
  }

  function syncTiles() {
    const present = new Set();
    participants.forEach((p, index) => {
      present.add(p.id);
      let tile = tiles.get(p.id);
      if (!tile) {
        tile = createTile();
        tiles.set(p.id, tile);
      }
      updateTile(tile, p);
      if (membersNode.children[index] !== tile.node) {
        membersNode.insertBefore(tile.node, membersNode.children[index] ?? null);
      }
    });

    for (const [id, tile] of tiles) {
      if (present.has(id)) continue;
      tile.node.remove();
      tiles.delete(id);
    }
  }

  function draw() {
    statusNode.className = `status ${status}`;
    statusLabel.nodeValue = STATUS_TEXT[status];
    qualityLabel.textContent = status === 'connected' ? (QUALITY_TEXT[quality] ?? '') : '';

    const people = participants.length;
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    metaLabel.textContent = `${people} ${people === 1 ? 'участник' : 'участника'} · ${formatTimer(seconds)}`;

    if (statusDetail) {
      bannerNode.lastChild.nodeValue = statusDetail;
      if (!bannerNode.isConnected) body.prepend(bannerNode);
    } else bannerNode.remove();

    body.classList.toggle('is-sharing', Boolean(share));
    if (share) {
      if (shareSlot.dataset.track !== share.track.sid) {
        shareSlot.dataset.track = share.track.sid;
        shareSlot.replaceChildren(
          el('div', { class: 'share-surface' }, [
            share.track.attach(),
            el('div', { class: 'share-badge' }, [el('span', { class: 'dot' }), share.name]),
          ]),
        );
      }
    } else if (shareSlot.dataset.track) {
      delete shareSlot.dataset.track;
      shareSlot.replaceChildren();
    }

    syncTiles();

    sideList.replaceChildren(
      ...participants.map((p) =>
        el('div', { class: `side-person${p.speaking && !p.muted ? ' is-speaking' : ''}` }, [
          el('span', { class: 'side-dot', text: initial(p.name) }),
          el('span', { class: 'rail-name', text: p.local ? 'Вы' : p.name }),
          icon(p.muted ? 'micOff' : 'mic', 15),
        ]),
      ),
    );

    micButton.replaceChildren(icon(muted ? 'micOff' : 'mic'));
    micButton.className = `ctl${muted ? ' is-off' : ''}`;
    micButton.disabled = !micAvailable || status !== 'connected' || busyControl === 'mic';

    cameraButton.replaceChildren(icon(cameraOn ? 'camera' : 'cameraOff'));
    cameraButton.className = `ctl${cameraOn ? ' is-on' : ''}`;
    cameraButton.disabled = status !== 'connected' || busyControl === 'camera';

    shareButton.replaceChildren(icon('share'));
    shareButton.className = `ctl${sharing ? ' is-on' : ''}`;
    shareButton.disabled = status !== 'connected' || busyControl === 'share';

    peopleButton.replaceChildren(icon('people'));
    hangButton.replaceChildren(icon('hangup'));
    hangButton.disabled = leaving;

    hintNode.textContent = leaving
      ? 'Выходим из звонка…'
      : sharing
        ? 'Вы показываете экран'
        : share
          ? share.name
          : 'Микрофон, камера, демонстрация экрана';

    if (!screen.isConnected) mount(screen);
  }

  const timerId = setInterval(draw, 1000);
  window.addEventListener('hashchange', () => clearInterval(timerId), { once: true });

  draw();
  connect();
}
