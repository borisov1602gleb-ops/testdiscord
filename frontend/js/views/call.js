// Экран звонка: подключение к комнате LiveKit, список участников,
// микрофон и выход с подсчётом длительности. Если сервер звонков недоступен,
// экран честно это показывает и всё равно корректно завершает участие —
// иначе время в базе осталось бы несосчитанным.
import { api } from '../api.js';
import { store } from '../store.js';
import { el, mount } from '../dom.js';
import { navigate } from '../router.js';

export async function renderCall(callId) {
  const active = store.activeCall;
  if (!active || active.callId !== callId) {
    return mount(
      el('div', { class: 'centered' }, [
        el('div', { class: 'card' }, [
          el('h1', { text: 'Звонок недоступен' }),
          el('p', { class: 'subtitle', text: 'Подключитесь к звонку заново из канала или по приглашению' }),
          el('div', { class: 'actions' }, [
            el('button', { text: 'На главную', onclick: () => navigate('#/') }),
          ]),
        ]),
      ]),
    );
  }

  // Живёт вне #app: перерисовка экрана не должна прерывать воспроизведение.
  document.getElementById('audio-sink')?.remove();
  const audioSink = el('div', { id: 'audio-sink', style: 'display:none' });
  document.body.append(audioSink);

  let room = null;
  let livekit = null;
  let status = 'connecting';
  let statusDetail = '';
  let muted = false;
  let micAvailable = true;
  let leaving = false;
  let participants = [{ identity: active.identity, local: true, speaking: false }];

  async function connect() {
    try {
      livekit = await import('/vendor/livekit-client.esm.mjs');
      const { Room, RoomEvent } = livekit;
      room = new Room();

      room.on(RoomEvent.ParticipantConnected, syncParticipants);
      room.on(RoomEvent.ParticipantDisconnected, syncParticipants);
      room.on(RoomEvent.ActiveSpeakersChanged, syncParticipants);
      room.on(RoomEvent.TrackMuted, syncParticipants);
      room.on(RoomEvent.TrackUnmuted, syncParticipants);
      // Элементы с аудио должны жить в DOM: открепление от документа
      // делает воспроизведение ненадёжным.
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== 'audio') return;
        const audio = track.attach();
        audio.autoplay = true;
        audioSink.append(audio);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((element) => element.remove());
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
      syncParticipants();
    } catch (err) {
      // Звонковый сервер может быть не поднят: участие всё равно записано
      // в БД, поэтому корректный выход из звонка обязан работать и здесь.
      console.error('livekit:', err);
      status = 'failed';
      statusDetail = 'Не удалось подключиться к серверу звонков. Остальное работает — можно выйти и попробовать снова';
      draw();
    }
  }

  function syncParticipants() {
    const local = room?.localParticipant;
    participants = [
      {
        identity: local?.identity ?? active.identity,
        local: true,
        speaking: Boolean(local?.isSpeaking),
        muted,
      },
      ...(room ? [...room.remoteParticipants.values()] : []).map((p) => {
        // isMicrophoneEnabled возвращает true, когда публикации нет вовсе,
        // поэтому состояние читаем с самой публикации дорожки.
        const micPublication = livekit
          ? p.getTrackPublication(livekit.Track.Source.Microphone)
          : null;
        return {
          identity: p.identity,
          local: false,
          speaking: p.isSpeaking,
          muted: !micPublication || micPublication.isMuted,
        };
      }),
    ];
    draw();
  }

  async function toggleMute() {
    muted = !muted;
    // Интерфейс реагирует сразу, не дожидаясь ответа SDK.
    syncParticipants();
    try {
      await room?.localParticipant.setMicrophoneEnabled(!muted);
    } catch (err) {
      console.error('микрофон:', err);
      micAvailable = false;
    }
    syncParticipants();
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
    const guestInvite = active.guest ? active.inviteId : null;
    mount(
      el('div', { class: 'centered' }, [
        el('div', { class: 'card' }, [
          el('h1', { text: 'Звонок завершён' }),
          el('p', {
            class: 'subtitle',
            text:
              durationSec != null
                ? `Вы были в звонке ${formatDuration(durationSec)}`
                : (error ?? ''),
          }),
          guestInvite &&
            el('div', {
              class: 'banner',
              text: 'Зарегистрируйтесь, чтобы остаться в сообществе и писать в чат',
            }),
          el('div', { class: 'actions' }, [
            guestInvite
              ? el('button', {
                  text: 'Зарегистрироваться',
                  onclick: () => {
                    store.pendingInvite = guestInvite;
                    navigate('#/login');
                  },
                })
              : el('button', {
                  text: 'Вернуться к каналам',
                  onclick: () => navigate(active.communityId ? `#/c/${active.communityId}` : '#/'),
                }),
            guestInvite &&
              el('button', {
                class: 'secondary',
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

  // Узлы создаются один раз: участники в звонке обновляются часто, и полная
  // перерисовка теряла бы нажатия по кнопкам, попавшие в момент замены DOM.
  const statusLabel = document.createTextNode('');
  const statusNode = el('p', { class: 'call-status' }, [el('span', { class: 'dot' }), statusLabel]);
  const bannerNode = el('div', { class: 'banner warning' });
  const participantsNode = el('div', { class: 'participants' });
  const muteButton = el('button', { class: 'secondary', onclick: toggleMute });
  const leaveButton = el('button', { class: 'danger', onclick: leave });

  const screen = el('div', { class: 'call' }, [
    el('div', {}, [
      el('h1', { text: active.channelName ?? 'Звонок' }),
      active.communityName && el('p', { class: 'subtitle', text: active.communityName }),
    ]),
    statusNode,
    bannerNode,
    participantsNode,
    el('div', { class: 'call-controls' }, [muteButton, leaveButton]),
    active.guest &&
      el('p', {
        class: 'hint',
        text: 'Вы в звонке как гость — после выхода можно зарегистрироваться и остаться в сообществе',
      }),
  ]);

  function draw() {
    statusNode.className = `call-status ${status}`;
    statusLabel.nodeValue = {
      connecting: 'Подключаемся…',
      connected: 'В звонке',
      failed: 'Нет связи',
    }[status];

    bannerNode.textContent = statusDetail;
    bannerNode.hidden = !statusDetail;

    participantsNode.replaceChildren(
      ...participants.map((p) =>
        el('div', { class: `participant${p.speaking ? ' speaking' : ''}` }, [
          el('div', { class: 'avatar', text: (p.identity ?? '?').slice(0, 1) }),
          el('div', { class: 'participant-name', text: p.local ? 'Вы' : p.identity }),
          el('div', {
            class: 'participant-state',
            text: p.muted ? 'микрофон выключен' : p.speaking ? 'говорит' : 'слушает',
          }),
        ]),
      ),
    );

    muteButton.textContent = muted ? 'Включить микрофон' : 'Выключить микрофон';
    muteButton.disabled = !micAvailable || status !== 'connected';
    leaveButton.textContent = leaving ? 'Выходим…' : 'Выйти из звонка';
    leaveButton.disabled = leaving;

    if (!screen.isConnected) mount(screen);
  }

  draw();
  connect();
}
