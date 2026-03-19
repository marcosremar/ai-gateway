/** Ambient type stubs for optional @pipecat-ai packages (dynamically imported at runtime). */

declare module '@pipecat-ai/client-js' {
  export class PipecatClient {
    constructor(opts: any);
    connect(opts?: any): Promise<void>;
    disconnect(): Promise<void>;
    on(event: string, handler: (...args: any[]) => void): void;
    off(event: string, handler: (...args: any[]) => void): void;
    action(action: any): Promise<any>;
    enableMic(enabled: boolean): void;
    enableCam(enabled: boolean): void;
    tracks(): { remote: { audio?: MediaStreamTrack } };
  }
  export const RTVIEvent: Record<string, string>;
}

declare module '@pipecat-ai/small-webrtc-transport' {
  export class SmallWebRTCTransport {
    constructor(opts?: any);
  }
}
