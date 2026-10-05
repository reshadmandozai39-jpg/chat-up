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

  it('broadcasts the message and sender to all connected clients', () => {
    const emit = vi.fn();
    gateway.server = { emit } as unknown as Server;

    gateway.handleMessage(
      { user: 'Anna', message: 'Hallo zusammen' },
      { id: 'client-1' } as Socket,
    );

    expect(emit).toHaveBeenCalledWith('receivedMessage', {
      user: 'Anna',
      message: 'Hallo zusammen',
    });
  });

  it('ignores empty messages', () => {
    const emit = vi.fn();
    gateway.server = { emit } as unknown as Server;

    gateway.handleMessage({ user: 'Anna', message: '  ' }, { id: 'client-1' } as Socket);

    expect(emit).not.toHaveBeenCalled();
  });
});
