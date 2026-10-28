/**
 * Stream multiplexer for the DSH Link tunnel.
 *
 * One transport, many logical HTTP and WebSocket streams, credit-based flow
 * control on both stream and connection level, and a weighted scheduler that
 * keeps interactive traffic ahead of bulk transfers.
 *
 * The mux deliberately knows nothing about HTTP or DSH: it moves opaque
 * streams. `apps/edge` and `apps/agent` own the semantics.
 */
import {
  CloseCode,
  DATA_CHUNK_BYTES,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  FrameType,
  INITIAL_CONNECTION_WINDOW,
  INITIAL_STREAM_WINDOW,
  ProtocolError,
  WINDOW_UPDATE_THRESHOLD,
  decodeCloseBody,
  decodeFrame,
  decodeJson,
  decodeUint32,
  decodeWsFrame,
  encodeCloseBody,
  encodeFrame,
  encodeJson,
  encodeTimestamp,
  encodeUint32,
  encodeWsFrame,
  isEnd,
  isHead,
  isOpen,
  isOpenAck,
  isReset,
  isGoAway,
  type End,
  type GoAway,
  type Head,
  type HelloAck,
  type Open,
  type OpenAck,
  type Priority,
  type Reset,
  type StreamKind,
  type WsOpcodeValue,
} from '@dsh-link/protocol';

export interface MuxTransport {
  /** Queue one binary message. Throws when the transport is gone. */
  send(data: Uint8Array): void;
  /** Close the underlying transport. */
  close(code: number, reason: string): void;
  /** Bytes the OS/runtime still holds. Used for transport backpressure. */
  readonly bufferedAmount: number;
}

export type Role = 'edge' | 'agent';

export interface MuxOptions {
  transport: MuxTransport;
  role: Role;
  heartbeatMs?: number;
  idleTimeoutMs?: number;
  initialStreamWindow?: number;
  initialConnectionWindow?: number;
  /** Agent only: called once per accepted OPEN. */
  onStream?: (stream: Stream) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
  /** Clock injection for tests. */
  now?: () => number;
}

interface QueuedFrame {
  frame: Uint8Array;
  stream?: Stream;
}

const HIGH_WATER_BYTES = 2 * 1024 * 1024;
const MAX_QUEUED_FRAMES = 2048;

export interface MuxStats {
  bytesIn: number;
  bytesOut: number;
  streamsOpened: number;
  streamsActive: number;
  rttMs: number | undefined;
  queuedFrames: number;
  sendCredit: number;
}

/**
 * One logical stream. Created by `mux.open()` on the edge, or delivered to
 * `onStream` on the agent.
 */
export class Stream {
  readonly id: number;
  readonly kind: StreamKind;
  readonly priority: Priority;
  readonly open: Open;

  private readonly mux: Mux;
  private sendCredit: number;
  private recvCredit: number;
  private recvConsumed = 0;
  private readonly updateThreshold: number;
  private closed = false;
  private localEnded = false;
  private remoteEnded = false;
  private resetReason: Reset | undefined;
  private headValue: Head | undefined;
  private headReject: ((error: Error) => void) | undefined;
  private headResolve: ((head: Head) => void) | undefined;
  private readonly bodyQueue: Uint8Array[] = [];
  private bodyBytes = 0;
  private bodyWaiter: (() => void) | undefined;
  private endResolve: (() => void) | undefined;
  private endPromise: Promise<void>;
  private resetListeners: Array<(reset: Reset) => void> = [];
  private frameListeners: Array<(opcode: WsOpcodeValue, data: Uint8Array) => void> = [];
  private openAckValue: OpenAck | undefined;
  private openAckResolve: ((ack: OpenAck) => void) | undefined;
  private openAckReject: ((error: Error) => void) | undefined;
  private earlyFrames: Array<{ opcode: WsOpcodeValue; data: Uint8Array }> = [];
  private earlyFrameBytes = 0;
  private creditWaiters: Array<() => void> = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(mux: Mux, id: number, open: Open, sendCredit: number) {
    this.mux = mux;
    this.id = id;
    this.kind = open.kind;
    this.priority = open.priority;
    this.open = open;
    this.sendCredit = sendCredit;
    this.recvCredit = mux.initialStreamWindow;
    // Never wait for more consumption than half the window, otherwise a window
    // smaller than the global threshold can never be replenished.
    this.updateThreshold = Math.max(1, Math.min(WINDOW_UPDATE_THRESHOLD, Math.floor(mux.initialStreamWindow / 2)));
    this.endPromise = new Promise<void>((resolve) => {
      this.endResolve = resolve;
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isEnded(): boolean {
    return this.localEnded && this.remoteEnded;
  }

  /** Bytes currently buffered for the consumer. */
  get bufferedBytes(): number {
    return this.bodyBytes;
  }

  /**
   * Send a chunk of the request body. Resolves when the bytes were accepted by
   * the scheduler **and** flow-control credit is available; callers therefore
   * get real backpressure without polling.
   */
  write(chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength === 0) return Promise.resolve();
    // Serialize per stream so concurrent writers cannot interleave.
    const run = this.writeChain.then(() => this.writeInner(chunk));
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async writeInner(chunk: Uint8Array): Promise<void> {
    if (this.closed || this.localEnded) throw new ProtocolError('STREAM_CLOSED', 'stream is not writable');
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.closed) throw new ProtocolError('STREAM_CLOSED', 'stream closed while writing');
      const chunkLength = Math.min(DATA_CHUNK_BYTES, chunk.byteLength - offset);
      const granted = await this.acquire(chunkLength);
      if (granted === 0) continue;
      const slice = chunk.subarray(offset, offset + granted);
      this.mux.enqueueData(this, encodeFrame(FrameType.Data, this.id, slice));
      offset += granted;
    }
  }

  /** End the local half of the stream. Queued data is flushed first. */
  end(payload?: End): Promise<void> {
    if (this.localEnded || this.closed) return Promise.resolve();
    this.localEnded = true;
    const run = this.writeChain.then(() => {
      if (this.closed) return;
      this.mux.enqueueData(this, encodeFrame(FrameType.End, this.id, payload === undefined ? undefined : encodeJson(payload)));
      // HTTP streams are bidirectional: the request half ending says nothing
      // about the response half. Release only once both halves are done.
      this.maybeRelease();
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  /** Abort. Control-queued, so it overtakes any pending data. */
  reset(code: string, message: string, retryable = false): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.mux.enqueueControl(encodeFrame(FrameType.Reset, this.id, encodeJson({ code, message, retryable } satisfies Reset)));
    } catch {
      /* transport already gone */
    }
    this.failLocal(new Error(`${code}: ${message}`));
  }

  /** Agent → edge: signal that the upstream WebSocket handshake succeeded. */
  sendOpenAck(ack: OpenAck): void {
    if (this.closed) return;
    this.mux.enqueueControl(encodeFrame(FrameType.OpenAck, this.id, encodeJson(ack)));
  }

  /** Agent → edge: response status and headers for an HTTP stream. */
  sendHead(head: Head): void {
    if (this.closed) return;
    this.mux.enqueueControl(encodeFrame(FrameType.Head, this.id, encodeJson(head)));
  }

  /** Send one WebSocket frame. Ordering with END is preserved. */
  sendFrame(opcode: WsOpcodeValue, data: Uint8Array): void {
    if (this.closed) return;
    const body = encodeWsFrame(opcode, data);
    this.mux.enqueueData(this, encodeFrame(FrameType.WsFrame, this.id, body));
  }

  sendClose(code: number, reason: string): void {
    this.sendFrame(8, encodeCloseBody(code, reason));
  }

  /** Resolves with the agent's OPEN_ACK (WebSocket handshake result). */
  openAck(): Promise<OpenAck> {
    if (this.openAckValue !== undefined) return Promise.resolve(this.openAckValue);
    if (this.closed) return Promise.reject(new Error('stream closed before open ack'));
    return new Promise<OpenAck>((resolve, reject) => {
      this.openAckResolve = resolve;
      this.openAckReject = reject;
    });
  }

  /** Resolves with the response head, or rejects on reset / close. */
  head(): Promise<Head> {
    if (this.headValue !== undefined) return Promise.resolve(this.headValue);
    if (this.resetReason !== undefined) return Promise.reject(new Error(`${this.resetReason.code}: ${this.resetReason.message}`));
    if (this.closed) return Promise.reject(new Error('stream closed before head'));
    return new Promise<Head>((resolve, reject) => {
      this.headResolve = resolve;
      this.headReject = reject;
    });
  }

  /** Async body. Credit is granted to the sender as chunks are consumed. */
  async *body(): AsyncIterable<Uint8Array> {
    while (true) {
      const chunk = this.bodyQueue.shift();
      if (chunk !== undefined) {
        this.bodyBytes -= chunk.byteLength;
        this.grantCredit(chunk.byteLength);
        yield chunk;
        continue;
      }
      if (this.resetReason !== undefined) {
        throw new Error(`${this.resetReason.code}: ${this.resetReason.message}`);
      }
      if (this.remoteEnded) return;
      await new Promise<void>((resolve) => {
        this.bodyWaiter = resolve;
      });
    }
  }

  waitForEnd(): Promise<void> {
    return this.endPromise;
  }

  onReset(listener: (reset: Reset) => void): () => void {
    this.resetListeners.push(listener);
    return () => {
      this.resetListeners = this.resetListeners.filter((entry) => entry !== listener);
    };
  }

  onFrame(listener: (opcode: WsOpcodeValue, data: Uint8Array) => void): () => void {
    this.frameListeners.push(listener);
    if (this.earlyFrames.length > 0) {
      const buffered = this.earlyFrames;
      this.earlyFrames = [];
      this.earlyFrameBytes = 0;
      for (const { opcode, data } of buffered) listener(opcode, data);
    }
    return () => {
      this.frameListeners = this.frameListeners.filter((entry) => entry !== listener);
    };
  }

  /* ---------------------------- internals ---------------------------- */

  private async acquire(wanted: number): Promise<number> {
    while (true) {
      if (this.closed) throw new ProtocolError('STREAM_CLOSED', 'stream closed while waiting for credit');
      const streamRoom = Math.max(0, this.sendCredit);
      const connectionRoom = Math.max(0, this.mux.sendCredit);
      const granted = Math.min(wanted, streamRoom, connectionRoom);
      if (granted > 0) {
        this.sendCredit -= granted;
        this.mux.sendCredit -= granted;
        return granted;
      }
      await new Promise<void>((resolve) => {
        this.creditWaiters.push(resolve);
      });
    }
  }

  /** Called by the mux when a WINDOW frame arrives. */
  addCredit(amount: number): void {
    this.sendCredit += amount;
    this.wake();
  }

  wake(): void {
    const waiters = this.creditWaiters;
    this.creditWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Called by the mux for DATA on this stream. */
  receiveData(chunk: Uint8Array): void {
    if (this.closed) return;
    this.recvCredit -= chunk.byteLength;
    if (this.recvCredit < 0) {
      this.reset('FLOW_CONTROL_VIOLATION', 'peer exceeded the granted window');
      return;
    }
    this.bodyQueue.push(chunk);
    this.bodyBytes += chunk.byteLength;
    this.wakeBody();
  }

  receiveHead(head: Head): void {
    this.headValue = head;
    this.headResolve?.(head);
    this.headResolve = undefined;
    this.headReject = undefined;
  }

  receiveOpenAck(ack: OpenAck): void {
    this.openAckValue = ack;
    this.openAckResolve?.(ack);
    this.openAckResolve = undefined;
    this.openAckReject = undefined;
  }

  receiveEnd(payload: End): void {
    this.remoteEnded = true;
    if (payload.error !== undefined) {
      this.resetReason = { code: payload.error.code, message: payload.error.message };
    }
    this.wakeBody();
    this.endResolve?.();
    this.maybeRelease();
  }

  /**
   * Drop the stream from the routing table only when neither direction can
   * produce more frames. Deleting on the first END would strand the opposite
   * half (a GET with no body would lose every response WINDOW update and
   * stall at exactly one stream window).
   */
  private maybeRelease(): void {
    if (this.localEnded && this.remoteEnded) this.mux.releaseStream(this.id);
  }

  receiveReset(reset: Reset): void {
    this.resetReason = reset;
    this.closed = true;
    this.wakeBody();
    this.wake();
    this.endResolve?.();
    this.headReject?.(new Error(`${reset.code}: ${reset.message}`));
    this.headReject = undefined;
    this.openAckReject?.(new Error(`${reset.code}: ${reset.message}`));
    this.openAckReject = undefined;
    for (const listener of this.resetListeners) listener(reset);
  }

  receiveFrame(opcode: WsOpcodeValue, data: Uint8Array): void {
    if (this.frameListeners.length === 0) {
      this.earlyFrameBytes += data.byteLength;
      if (this.earlyFrameBytes > 1024 * 1024) {
        this.reset('WS_FRAME_BUFFER', 'too many frames before the consumer attached');
        return;
      }
      this.earlyFrames.push({ opcode, data });
      return;
    }
    for (const listener of this.frameListeners) listener(opcode, data);
  }

  private grantCredit(amount: number): void {
    this.recvConsumed += amount;
    if (this.recvConsumed >= this.updateThreshold && !this.remoteEnded && !this.closed && this.mux.hasStream(this.id)) {
      const delta = this.recvConsumed;
      this.recvConsumed = 0;
      this.recvCredit += delta;
      this.mux.enqueueControl(encodeFrame(FrameType.Window, this.id, encodeUint32(delta)));
    }
    this.mux.grantConnectionCredit(amount);
  }

  private wakeBody(): void {
    const waiter = this.bodyWaiter;
    this.bodyWaiter = undefined;
    waiter?.();
  }

  /** Transport died or the mux closed: fail the local side without protocol frames. */
  failLocal(error: Error): void {
    if (this.resetReason === undefined) {
      this.resetReason = { code: 'STREAM_CLOSED', message: error.message };
    }
    this.closed = true;
    this.wakeBody();
    this.wake();
    this.endResolve?.();
    this.headReject?.(error);
    this.headReject = undefined;
    this.openAckReject?.(error);
    this.openAckReject = undefined;
    for (const listener of this.resetListeners) listener(this.resetReason);
  }
}

export class Mux {
  readonly role: Role;
  readonly initialStreamWindow: number;
  readonly initialConnectionWindow: number;
  private readonly transport: MuxTransport;
  private readonly heartbeatMs: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly onStream: ((stream: Stream) => void) | undefined;
  private readonly onCloseCallback: ((code: number, reason: string) => void) | undefined;
  private readonly onErrorCallback: ((error: Error) => void) | undefined;

  private readonly streams = new Map<number, Stream>();
  private nextStreamId = 1;
  private closed = false;

  sendCredit: number;
  private recvCredit: number;
  private recvConsumed = 0;
  private readonly connectionUpdateThreshold: number;

  private controlQueue: QueuedFrame[] = [];
  private highQueue: QueuedFrame[] = [];
  private normalQueue: QueuedFrame[] = [];
  private lowQueue: QueuedFrame[] = [];
  private pumpScheduled = false;
  private pumpRunning = false;
  private pumpWake: (() => void) | undefined;
  private schedulerTick = 0;

  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private lastReceivedAt: number;
  private lastPingAt = 0;
  private rttMs: number | undefined;

  private bytesIn = 0;
  private bytesOut = 0;
  private streamsOpened = 0;

  constructor(options: MuxOptions) {
    this.role = options.role;
    this.transport = options.transport;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.initialStreamWindow = options.initialStreamWindow ?? INITIAL_STREAM_WINDOW;
    this.initialConnectionWindow = options.initialConnectionWindow ?? INITIAL_CONNECTION_WINDOW;
    this.sendCredit = this.initialConnectionWindow;
    this.recvCredit = this.initialConnectionWindow;
    this.connectionUpdateThreshold = Math.max(1, Math.min(WINDOW_UPDATE_THRESHOLD, Math.floor(this.initialConnectionWindow / 2)));
    this.onStream = options.onStream;
    this.onCloseCallback = options.onClose;
    this.onErrorCallback = options.onError;
    this.now = options.now ?? (() => Date.now());
    this.lastReceivedAt = this.now();
  }

  /** Begin heartbeat supervision. */
  start(): void {
    if (this.heartbeatTimer !== undefined || this.closed) return;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  stats(): MuxStats {
    return {
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      streamsOpened: this.streamsOpened,
      streamsActive: this.streams.size,
      rttMs: this.rttMs,
      queuedFrames: this.controlQueue.length + this.highQueue.length + this.normalQueue.length + this.lowQueue.length,
      sendCredit: this.sendCredit,
    };
  }

  /** Edge only: open a new stream toward the agent. */
  open(open: Open): Stream {
    if (this.role !== 'edge') throw new Error('only the edge may open streams');
    if (this.closed) throw new Error('mux is closed');
    const id = this.nextStreamId++;
    if (this.nextStreamId > 0xffff_fffe) throw new Error('stream id space exhausted');
    const stream = new Stream(this, id, open, this.initialStreamWindow);
    this.streams.set(id, stream);
    this.streamsOpened += 1;
    this.enqueueControl(encodeFrame(FrameType.Open, id, encodeJson(open)));
    return stream;
  }

  /** Feed one received binary message. */
  handleMessage(data: Uint8Array): void {
    if (this.closed) return;
    this.bytesIn += data.byteLength;
    this.lastReceivedAt = this.now();
    let frame;
    try {
      frame = decodeFrame(data);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    try {
      this.dispatch(frame.type, frame.streamId, frame.payload);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.onErrorCallback?.(failure);
      // A malformed frame for one stream is that stream's failure, not the
      // connection's — unless it is a connection-level frame.
      if (frame.streamId === 0) this.fail(failure);
      else {
        const stream = this.streams.get(frame.streamId);
        stream?.reset('PROTOCOL_BAD_FRAME', failure.message);
      }
    }
  }

  private dispatch(type: number, streamId: number, payload: Uint8Array): void {
    switch (type) {
      case FrameType.Ping: {
        this.enqueueControl(encodeFrame(FrameType.Pong, 0, payload));
        return;
      }
      case FrameType.Pong: {
        const sentAt = Number(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigUint64(0, false));
        if (Number.isFinite(sentAt)) this.rttMs = Math.max(0, this.now() - sentAt);
        return;
      }
      case FrameType.GoAway: {
        const goAway: GoAway = decodeJson(payload, isGoAway);
        this.close(CloseCode.GoingAway, `${goAway.code}: ${goAway.message}`);
        return;
      }
      case FrameType.Window: {
        if (streamId === 0) {
          const delta = decodeUint32(payload);
          this.sendCredit += delta;
          for (const stream of this.streams.values()) stream.wake();
          return;
        }
        const stream = this.streams.get(streamId);
        stream?.addCredit(decodeUint32(payload));
        return;
      }
      case FrameType.Open: {
        if (this.role !== 'agent') throw new ProtocolError('PROTOCOL_BAD_FRAME', 'edge received OPEN');
        if (this.streams.has(streamId)) throw new ProtocolError('PROTOCOL_BAD_FRAME', `duplicate stream ${String(streamId)}`);
        const open = decodeJson(payload, isOpen);
        const stream = new Stream(this, streamId, open, this.initialStreamWindow);
        this.streams.set(streamId, stream);
        this.streamsOpened += 1;
        if (this.onStream === undefined) {
          stream.reset('STREAM_REJECTED', 'agent has no stream handler');
          return;
        }
        this.onStream(stream);
        return;
      }
      case FrameType.OpenAck: {
        const ack = decodeJson(payload, isOpenAck);
        const stream = this.requireStream(streamId);
        stream.receiveOpenAck?.(ack);
        return;
      }
      case FrameType.Head: {
        const head = decodeJson(payload, isHead);
        this.requireStream(streamId).receiveHead(head);
        return;
      }
      case FrameType.Data: {
        if (payload.byteLength === 0) return;
        this.recvCredit -= payload.byteLength;
        if (this.recvCredit < 0) {
          this.requireStream(streamId).reset('FLOW_CONTROL_VIOLATION', 'connection window exceeded');
          return;
        }
        this.requireStream(streamId).receiveData(payload);
        return;
      }
      case FrameType.WsFrame: {
        const { opcode, data } = decodeWsFrame(payload);
        this.requireStream(streamId).receiveFrame(opcode, data);
        return;
      }
      case FrameType.End: {
        const end = payload.byteLength === 0 ? {} : decodeJson(payload, isEnd);
        this.requireStream(streamId).receiveEnd(end);
        return;
      }
      case FrameType.Reset: {
        const reset = decodeJson(payload, isReset);
        const stream = this.streams.get(streamId);
        stream?.receiveReset(reset);
        this.closeStream(streamId);
        return;
      }
      default:
        throw new ProtocolError('PROTOCOL_BAD_FRAME', `unexpected frame type ${String(type)}`);
    }
  }

  private requireStream(streamId: number): Stream {
    const stream = this.streams.get(streamId);
    if (stream === undefined) throw new ProtocolError('PROTOCOL_BAD_FRAME', `unknown stream ${String(streamId)}`);
    return stream;
  }

  private closeStream(streamId: number): void {
    const stream = this.streams.get(streamId);
    if (stream === undefined) return;
    // Keep the stream object alive for its consumer until it drains, but stop
    // routing new frames to it.
    this.streams.delete(streamId);
  }

  /** Whether a stream is still attached to this mux (not fully ended/reset). */
  hasStream(streamId: number): boolean {
    return this.streams.has(streamId);
  }

  /** Remove a fully closed stream from routing. Safe to call twice. */
  releaseStream(streamId: number): void {
    this.streams.delete(streamId);
  }

  private heartbeat(): void {
    if (this.closed) return;
    const now = this.now();
    if (now - this.lastReceivedAt > this.idleTimeoutMs) {
      this.close(CloseCode.HeartbeatTimeout, 'heartbeat timeout');
      return;
    }
    if (now - this.lastPingAt >= this.heartbeatMs) {
      this.lastPingAt = now;
      try {
        this.enqueueControl(encodeFrame(FrameType.Ping, 0, encodeTimestamp(now)));
      } catch {
        this.fail(new Error('transport rejected heartbeat'));
      }
    }
  }

  /* ------------------------- scheduling ------------------------- */

  enqueueControl(frame: Uint8Array): void {
    if (this.closed) return;
    this.push({ frame }, this.controlQueue);
  }

  enqueueData(stream: Stream, frame: Uint8Array): void {
    if (this.closed) return;
    const queue = stream.priority === 'high' ? this.highQueue : stream.priority === 'low' ? this.lowQueue : this.normalQueue;
    this.push({ frame, stream }, queue);
  }

  private push(item: QueuedFrame, queue: QueuedFrame[]): void {
    if (queue.length >= MAX_QUEUED_FRAMES) {
      this.fail(new Error('outbound queue overflow'));
      return;
    }
    queue.push(item);
    this.schedulePump();
  }

  private schedulePump(): void {
    if (this.pumpRunning) {
      this.pumpWake?.();
      return;
    }
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    this.pumpRunning = true;
    this.pumpScheduled = false;
    try {
      while (!this.closed) {
        const item = this.pick();
        if (item === undefined) {
          await new Promise<void>((resolve) => {
            this.pumpWake = resolve;
          });
          this.pumpWake = undefined;
          continue;
        }
        if (item.stream !== undefined && item.stream.isClosed && item.frame[0] !== FrameType.Reset) continue;
        this.transport.send(item.frame);
        this.bytesOut += item.frame.byteLength;
        if (this.transport.bufferedAmount > HIGH_WATER_BYTES) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.pumpRunning = false;
    }
  }

  private pick(): QueuedFrame | undefined {
    const control = this.controlQueue.shift();
    if (control !== undefined) return control;
    // Weighted 4:2:1 across high:normal:low, falling through when a class is empty.
    this.schedulerTick = (this.schedulerTick + 1) % 7;
    const order: QueuedFrame[][] = this.schedulerTick < 4
      ? [this.highQueue, this.normalQueue, this.lowQueue]
      : this.schedulerTick < 6
        ? [this.normalQueue, this.highQueue, this.lowQueue]
        : [this.lowQueue, this.highQueue, this.normalQueue];
    for (const queue of order) {
      const item = queue.shift();
      if (item !== undefined) return item;
    }
    return undefined;
  }

  grantConnectionCredit(amount: number): void {
    if (this.closed) return;
    this.recvConsumed += amount;
    if (this.recvConsumed >= this.connectionUpdateThreshold) {
      const delta = this.recvConsumed;
      this.recvConsumed = 0;
      this.recvCredit += delta;
      this.enqueueControl(encodeFrame(FrameType.Window, 0, encodeUint32(delta)));
    }
  }

  /* --------------------------- lifecycle --------------------------- */

  close(code: number, reason: string): void {
    if (this.closed) return;
    try {
      this.transport.close(code, reason);
    } catch {
      /* already closed */
    }
    this.handleTransportClose(code, reason);
  }

  /**
   * Called by the transport wrapper when the socket closes for any reason.
   * Fails every stream locally and reports the close exactly once.
   */
  handleTransportClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.pumpWake?.();
    for (const stream of this.streams.values()) {
      stream.failLocal(new Error(`${String(code)}: ${reason}`));
    }
    this.streams.clear();
    this.onCloseCallback?.(code, reason);
  }

  private fail(error: Error): void {
    this.onErrorCallback?.(error);
    this.close(CloseCode.ProtocolError, error.message);
  }
}

/** Decode a close frame body for callers that need code + reason. */
export { decodeCloseBody };