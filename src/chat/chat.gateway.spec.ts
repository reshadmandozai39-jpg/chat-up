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
    expect(emit).toHaveBeenCalledWith('receivedMessage', {
      senderId: 'client-1',
      user: 'Anna',
      message: 'Hallo zusammen',
    });
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
    gateway.server = { sockets: { adapter: { rooms } } } as unknown as Server;

    await gateway.handleJoinRoom('raum-1', {
      id: 'client-3',
      data: {},
      join,
      emit,
    } as unknown as Socket);

    expect(join).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('roomError', 'Dieser Raum ist bereits mit zwei Personen belegt.');
  });
});
