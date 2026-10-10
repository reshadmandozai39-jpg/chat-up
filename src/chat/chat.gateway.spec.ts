import { Test, TestingModule } from '@nestjs/testing';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server, Socket } from 'socket.io';
import { ChatGateway } from './chat.gateway.js';
import { ChatService } from './chat.service.js';

describe('ChatGateway', () => {
  let gateway: ChatGateway;
  const getOrCreateMockUser = vi.fn();
  const getOrCreateChatRoom = vi.fn();
  const saveMessage = vi.fn();
  const getRecentMessages = vi.fn();

  beforeEach(async () => {
    getOrCreateMockUser.mockReset();
    getOrCreateMockUser.mockResolvedValue({ id: 7 });
    getOrCreateChatRoom.mockReset();
    getOrCreateChatRoom.mockResolvedValue({ id: 8 });
    saveMessage.mockReset();
    saveMessage.mockResolvedValue({ id: 41, createdAt: new Date('2026-01-01T12:00:00.000Z') });
    getRecentMessages.mockReset();
    getRecentMessages.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        {
          provide: ChatService,
          useValue: {
            getOrCreateMockUser,
            getOrCreateChatRoom,
            saveMessage,
            getRecentMessages,
          },
        },
      ],
    }).compile();

    gateway = module.get<ChatGateway>(ChatGateway);
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  it('sends configured TURN servers to a connected client', () => {
    const previousTurnUrls = process.env.TURN_URLS;
    const previousTurnUsername = process.env.TURN_USERNAME;
    const previousTurnCredential = process.env.TURN_CREDENTIAL;
    process.env.TURN_URLS = 'turn:turn.example.test:3478, turns:turn.example.test:5349';
    process.env.TURN_USERNAME = 'temporary-user';
    process.env.TURN_CREDENTIAL = 'temporary-credential';
    const emit = vi.fn();

    try {
      gateway.handleConnection({ id: 'client-1', emit } as unknown as Socket);

      expect(emit).toHaveBeenCalledWith('call:config', {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          {
            urls: ['turn:turn.example.test:3478', 'turns:turn.example.test:5349'],
            username: 'temporary-user',
            credential: 'temporary-credential',
          },
        ],
      });
    } finally {
      if (previousTurnUrls === undefined) delete process.env.TURN_URLS;
      else process.env.TURN_URLS = previousTurnUrls;
      if (previousTurnUsername === undefined) delete process.env.TURN_USERNAME;
      else process.env.TURN_USERNAME = previousTurnUsername;
      if (previousTurnCredential === undefined) delete process.env.TURN_CREDENTIAL;
      else process.env.TURN_CREDENTIAL = previousTurnCredential;
    }
  });

  it('saves and sends the message only to the sender room', async () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    gateway.server = { to } as unknown as Server;

    await gateway.handleMessage(
      { user: 'Anna', message: 'Hallo zusammen' },
      {
        id: 'client-1',
        data: { room: 'raum-1', user: 'Anna', userId: 7, chatRoomId: 8 },
      } as Socket,
    );

    expect(saveMessage).toHaveBeenCalledWith(7, 8, 'Hallo zusammen');
    expect(to).toHaveBeenCalledWith('raum-1');
    expect(emit).toHaveBeenCalledWith('receivedMessage', expect.objectContaining({
      messageId: '41',
      senderId: 'client-1',
      userId: 7,
      user: 'Anna',
      message: 'Hallo zusammen',
    }));
  });

  it('ignores empty messages', async () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    gateway.server = { to } as unknown as Server;

    await gateway.handleMessage(
      { user: 'Anna', message: '  ' },
      {
        id: 'client-1',
        data: { room: 'raum-1', user: 'Anna', userId: 7, chatRoomId: 8 },
      } as Socket,
    );

    expect(emit).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
  });

  it('stores an audio message and broadcasts its playable path', async () => {
    const previousUploadsDir = process.env.UPLOADS_DIR;
    const uploadsDir = await mkdtemp(join(tmpdir(), 'chat-up-audio-'));
    process.env.UPLOADS_DIR = uploadsDir;
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    gateway.server = { to } as unknown as Server;
    const audio = Buffer.from('wav voice data');

    try {
      await gateway.handleAudioMessage(
        { mimeType: 'audio/wav', data: audio },
        {
          id: 'client-1',
          data: { room: 'raum-1', user: 'Anna', userId: 7, chatRoomId: 8 },
        } as Socket,
      );

      expect(saveMessage).toHaveBeenCalledWith(
        7,
        8,
        expect.stringMatching(/^\/uploads\/audio\/[\w-]+\.wav$/),
        'AUDIO',
      );
      const audioPath = saveMessage.mock.calls[0][2] as string;
      expect(await readFile(join(uploadsDir, 'audio', audioPath.split('/').at(-1)!))).toEqual(audio);
      expect(to).toHaveBeenCalledWith('raum-1');
      expect(emit).toHaveBeenCalledWith('receivedMessage', expect.objectContaining({
        message: audioPath,
        type: 'AUDIO',
        user: 'Anna',
      }));
    } finally {
      if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = previousUploadsDir;
      await rm(uploadsDir, { recursive: true, force: true });
    }
  });

  it('does not send messages before the client joins a room', async () => {
    const to = vi.fn();
    gateway.server = { to } as unknown as Server;

    await gateway.handleMessage(
      { user: 'Anna', message: 'Hallo zusammen' },
      { id: 'client-1', data: {} } as Socket,
    );

    expect(to).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
  });

  it('does not allow a third client into a full room', async () => {
    const emit = vi.fn();
    const join = vi.fn();
    const rooms = new Map([['raum-1', new Set(['client-1', 'client-2'])]]);
    const sockets = new Map([
      ['client-1', { data: { user: 'Anna' } }],
      ['client-2', { data: { user: 'Berta' } }],
    ]);
    gateway.server = { sockets: { adapter: { rooms }, sockets } } as unknown as Server;

    await gateway.handleJoinRoom({ room: 'raum-1', user: 'Carla' }, {
      id: 'client-3',
      data: {},
      join,
      emit,
    } as unknown as Socket);

    expect(join).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('roomError', 'Dieser Raum ist bereits mit zwei Personen belegt.');
  });

  it('allows another tab for a participant already in the room', async () => {
    const emit = vi.fn();
    const join = vi.fn();
    const rooms = new Map([['raum-1', new Set(['client-1', 'client-2'])]]);
    const sockets = new Map([
      ['client-1', { data: { user: 'Anna' } }],
      ['client-2', { data: { user: 'Berta' } }],
    ]);
    gateway.server = { sockets: { adapter: { rooms }, sockets } } as unknown as Server;

    await gateway.handleJoinRoom({ room: 'raum-1', user: 'Anna' }, {
      id: 'client-3',
      data: {},
      join,
      emit,
    } as unknown as Socket);

    expect(join).toHaveBeenCalledWith('raum-1');
    expect(emit).toHaveBeenCalledWith('roomJoined', { room: 'raum-1', userId: 7 });
    expect(getOrCreateMockUser).toHaveBeenCalledWith('Anna', undefined);
  });

  it('stores the mock user before joining a room', async () => {
    const emit = vi.fn();
    const join = vi.fn();
    const rooms = new Map();
    const sockets = new Map();
    gateway.server = { sockets: { adapter: { rooms }, sockets } } as unknown as Server;
    const client = { id: 'client-1', data: {}, join, emit } as unknown as Socket;

    await gateway.handleJoinRoom({ room: 'raum-1', user: 'Anna' }, client);

    expect(getOrCreateMockUser).toHaveBeenCalledWith('Anna', undefined);
    expect(client.data.userId).toBe(7);
    expect(getOrCreateChatRoom).toHaveBeenCalledWith('raum-1');
    expect(client.data.chatRoomId).toBe(8);
    expect(join).toHaveBeenCalledWith('raum-1');
    expect(getRecentMessages).toHaveBeenCalledWith(8);
    expect(emit).toHaveBeenCalledWith('roomJoined', { room: 'raum-1', userId: 7 });
    expect(emit).toHaveBeenCalledWith('messageHistory', []);
  });

  it('broadcasts read receipts only to the reader room', () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    gateway.server = { to } as unknown as Server;

    gateway.handleMessageRead(
      { messageId: 'message-1' },
      { id: 'client-2', data: { room: 'raum-1' } } as Socket,
    );

    expect(to).toHaveBeenCalledWith('raum-1');
    expect(emit).toHaveBeenCalledWith('messageRead', {
      messageId: 'message-1',
      readerId: 'client-2',
    });
  });

  it('sends a call invitation to the other user only', () => {
    const callerEmit = vi.fn();
    const peerEmit = vi.fn();
    const room = new Set(['caller', 'peer']);
    const sockets = new Map([
      ['caller', { data: { userId: 7, user: 'Anna' } }],
      ['peer', { data: { userId: 9, user: 'Berta' }, emit: peerEmit }],
    ]);

    gateway.server = {
      sockets: {
        adapter: { rooms: new Map([['raum-1', room]]) },
        sockets,
      },
    } as unknown as Server;

    gateway.handleCallInvite(
      { kind: 'video' },
      {
        id: 'caller',
        data: { room: 'raum-1', userId: 7, user: 'Anna' },
        emit: callerEmit,
      } as unknown as Socket,
    );

    expect(peerEmit).toHaveBeenCalledWith('call:incoming', {
      callId: 'caller',
      fromUserId: 7,
      fromName: 'Anna',
      kind: 'video',
    });
    expect(callerEmit).not.toHaveBeenCalled();
  });

  it('routes a call response to the inviter and clears the pending invitation', () => {
    const callerEmit = vi.fn();
    type CallKind = 'audio' | 'video';
    type CallState = { callId: string; peerSocketId: string; kind: CallKind };
    type CallTestSocket = {
      id: string;
      data: {
        userId?: number;
        room?: string;
        pendingCall?: CallState;
        incomingCall?: {
          callId: string;
          callerSocketId: string;
          callerUserId: number;
          kind: CallKind;
        };
        activeCall?: CallState;
      };
      emit: ReturnType<typeof vi.fn>;
    };
    const caller: CallTestSocket = {
      id: 'caller',
      data: {
        userId: 7,
        room: 'raum-1',
        pendingCall: { callId: 'caller', peerSocketId: 'callee', kind: 'audio' },
      },
      emit: callerEmit,
    };
    const callee: CallTestSocket = {
      id: 'callee',
      data: {
        room: 'raum-1',
        userId: 9,
        incomingCall: {
          callId: 'caller',
          callerSocketId: 'caller',
          callerUserId: 7,
          kind: 'audio',
        },
      },
      emit: vi.fn(),
    };
    const rooms = new Map([['raum-1', new Set(['caller', 'callee'])]]);
    const sockets = new Map<string, CallTestSocket>([
      ['caller', caller],
      ['callee', callee],
    ]);
    gateway.server = { sockets: { adapter: { rooms }, sockets } } as unknown as Server;

    gateway.handleCallResponse(
      { accepted: true },
      callee as unknown as Socket,
    );

    expect(callerEmit).toHaveBeenCalledWith('call:response', {
      accepted: true,
      callId: 'caller',
      kind: 'audio',
    });
    expect(caller.data.activeCall).toEqual({
      callId: 'caller',
      peerSocketId: 'callee',
      kind: 'audio',
    });
    expect(callee.data.activeCall).toEqual({
      callId: 'caller',
      peerSocketId: 'caller',
      kind: 'audio',
    });
    expect(callee.data.incomingCall).toBeUndefined();
  });

  it('relays WebRTC signaling only to the active call peer', () => {
    const peerEmit = vi.fn();
    const callId = 'call-1';
    const caller = {
      id: 'caller',
      data: {
        room: 'raum-1',
        activeCall: { callId, peerSocketId: 'peer', kind: 'video' },
      },
    };
    const peer = {
      id: 'peer',
      data: {
        room: 'raum-1',
        activeCall: { callId, peerSocketId: 'caller', kind: 'video' },
      },
      emit: peerEmit,
    };
    gateway.server = {
      sockets: { sockets: new Map([['caller', caller], ['peer', peer]]) },
    } as unknown as Server;

    gateway.handleCallSignal(
      { callId, signal: { type: 'offer', description: 'offer-data' } },
      caller as unknown as Socket,
    );

    expect(peerEmit).toHaveBeenCalledWith('call:signal', {
      callId,
      signal: { type: 'offer', description: 'offer-data' },
    });
  });

  it('ends the call for both participants', () => {
    const peerEmit = vi.fn();
    const callId = 'call-1';
    const caller = {
      id: 'caller',
      data: {
        activeCall: { callId, peerSocketId: 'peer', kind: 'audio' },
      },
    };
    const peer = {
      id: 'peer',
      data: {
        activeCall: { callId, peerSocketId: 'caller', kind: 'audio' },
      },
      emit: peerEmit,
    };
    gateway.server = {
      sockets: { sockets: new Map([['caller', caller], ['peer', peer]]) },
    } as unknown as Server;

    gateway.handleCallEnd({ callId }, caller as unknown as Socket);

    expect(peerEmit).toHaveBeenCalledWith('call:ended', { callId, reason: 'hangup' });
    expect(caller.data.activeCall).toBeUndefined();
    expect(peer.data.activeCall).toBeUndefined();
  });
});