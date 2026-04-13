/** Ambient type stubs for optional @pipecat-ai packages (dynamically imported at runtime). */

declare module '@pipecat-ai/client-js' {
  interface PipecatClientOpts {
    transport?: unknown;
    baseUrl?: string;
    [key: string]: unknown;
  }

  interface ConnectOpts {
    [key: string]: unknown;
  }

  interface ActionPayload {
    service?: string;
    action?: string;
    [key: string]: unknown;
  }

  interface ActionResult {
    result?: unknown;
    [key: string]: unknown;
  }

  export class PipecatClient {
    constructor(opts: PipecatClientOpts);
    connect(opts?: ConnectOpts): Promise<void>;
    disconnect(): Promise<void>;
    on(event: string, handler: (...args: unknown[]) => void): void;
    off(event: string, handler: (...args: unknown[]) => void): void;
    action(action: ActionPayload): Promise<ActionResult>;
    enableMic(enabled: boolean): void;
    enableCam(enabled: boolean): void;
    tracks(): { remote: { audio?: MediaStreamTrack } };
  }
  export const RTVIEvent: Record<string, string>;
}

declare module '@pipecat-ai/small-webrtc-transport' {
  interface SmallWebRTCTransportOpts {
    [key: string]: unknown;
  }

  export class SmallWebRTCTransport {
    constructor(opts?: SmallWebRTCTransportOpts);
  }
}
