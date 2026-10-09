import { Test, TestingModule } from '@nestjs/testing';
import { Server, Socket } from 'socket.io';
import { ChatGateway } from './chat.gateway.js';

describe('ChatGateway', () => {
  let gateway: ChatGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ChatGateway],
    }).compile();

    gateway = module.get<ChatGateway>(ChatGateway);
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  it('sends the message only to the sender room', () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    gateway.server = { to } as unknown as Server;

    gateway.handleMessage(
      { user: 'Anna', message: 'Hallo zusammen' },
      { id: 'client-1', data: { room: 'raum-1' } } as Socket,
    );

    expect(to).toHaveBeenCalledWith('raum-1');
    expect(emit).toHaveBeenCalledWith('receivedMessage', expect.objectContaining({
      messageId: expect.any(String),
      senderId: 'client-1',
      user: 'Anna',
      message: 'Hallo zusammen',
    }));
  });

  it('ignores empty messages', () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    gateway.server = { to } as unknown as Server;

    gateway.handleMessage(
      { user: 'Anna', message: '  ' },
      { id: 'client-1', data: { room: 'raum-1' } } as Socket,
    );

    expect(emit).not.toHaveBeenCalled();
  });

  it('does not send messages before the client joins a room', () => {
    const to = vi.fn();
    gateway.server = { to } as unknown as Server;

    gateway.handleMessage(
      { user: 'Anna', message: 'Hallo zusammen' },
      { id: 'client-1', data: {} } as Socket,
    );

    expect(to).not.toHaveBeenCalled();
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
    expect(emit).toHaveBeenCalledWith('roomJoined', { room: 'raum-1' });
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
});
