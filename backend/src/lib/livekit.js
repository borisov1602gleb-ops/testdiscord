import { AccessToken } from 'livekit-server-sdk';
import { config } from '../config.js';

// Комната LiveKit создаётся автоматически при подключении первого участника,
// поэтому на стороне backend достаточно выдать токен доступа.
export async function createCallToken({ roomName, identity, name, canPublish = true }) {
  const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity,
    name,
  });
  token.addGrant({ roomJoin: true, room: roomName, canPublish, canSubscribe: true });
  return token.toJwt();
}
