import { Room, type RoomConnectOptions, type RoomOptions } from 'livekit-client';

export interface CallJoin { url: string; token: string }

export interface JoinCallOptions {
  room?: RoomOptions;
  connect?: RoomConnectOptions;
  microphone?: boolean;
  camera?: boolean;
  timeoutMs?: number;
}

export async function joinCall(join: CallJoin, opts: JoinCallOptions = {}): Promise<Room> {
  const room = new Room({ adaptiveStream: true, dynacast: true, ...opts.room });
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`joinCall: not connected in ${timeoutMs} ms`)), timeoutMs); });
  try {
    await Promise.race([room.connect(join.url, join.token, opts.connect), timeout]);
  } catch (err) {
    await room.disconnect();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (opts.microphone) await room.localParticipant.setMicrophoneEnabled(true);
  if (opts.camera) await room.localParticipant.setCameraEnabled(true);
  return room;
}
