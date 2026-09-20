// Настройки, которые живут только в браузере: выбранные устройства, звуки и
// поведение при входе в звонок. На сервер они не ходят — ни на кого, кроме
// самого человека за этим компьютером, они не влияют.
const KEY = 'app_settings';

const DEFAULTS = {
  micDeviceId: '',
  cameraDeviceId: '',
  speakerDeviceId: '',
  joinMuted: false,
  soundOnMessage: true,
  soundOnJoin: true,
};

function read() {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY)) ?? {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings = {
  get all() {
    return read();
  },
  get(name) {
    return read()[name];
  },
  set(patch) {
    const next = { ...read(), ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* приватный режим — настройки просто не переживут вкладку */
    }
    return next;
  },
};

// Список устройств. Названия браузер отдаёт только после разрешения на
// микрофон, поэтому сначала спрашиваем его — иначе в списке будут пустые
// строки вместо «Микрофон гарнитуры».
export async function listDevices() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch {
    /* без разрешения покажем то, что есть */
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const byKind = (kind) =>
    devices
      .filter((device) => device.kind === kind)
      .map((device, index) => ({
        id: device.deviceId,
        label: device.label || `${kindLabel(kind)} ${index + 1}`,
      }));

  return {
    microphones: byKind('audioinput'),
    cameras: byKind('videoinput'),
    speakers: byKind('audiooutput'),
  };
}

function kindLabel(kind) {
  if (kind === 'audioinput') return 'Микрофон';
  if (kind === 'videoinput') return 'Камера';
  return 'Динамики';
}

// Короткий сигнал вместо звукового файла: не нужно тащить в репозиторий
// бинарник ради двух нот.
let audioContext = null;

export function playChime(kind) {
  const enabled = kind === 'message' ? settings.get('soundOnMessage') : settings.get('soundOnJoin');
  if (!enabled) return;

  try {
    audioContext ??= new AudioContext();
    if (audioContext.state === 'suspended') audioContext.resume();

    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(kind === 'message' ? 660 : 520, now);
    oscillator.frequency.exponentialRampToValueAtTime(kind === 'message' ? 880 : 700, now + 0.12);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.26);
  } catch {
    /* звук — не то, ради чего стоит ломать экран */
  }
}
