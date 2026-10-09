import { Test, TestingModule } from '@nestjs/testing';
import { ChatService } from './chat.service.js';
import { PrismaService } from '../database/prisma.service.js';

describe('ChatService', () => {
  let service: ChatService;
  const upsert = vi.fn();
  const roomUpsert = vi.fn();
  const messageCreate = vi.fn();
  const messageFindMany = vi.fn();

  beforeEach(async () => {
    upsert.mockReset();
    upsert.mockResolvedValue({ id: 7 });
    roomUpsert.mockReset();
    roomUpsert.mockResolvedValue({ id: 8 });
    messageCreate.mockReset();
    messageCreate.mockResolvedValue({ id: 41 });
    messageFindMany.mockReset();
    messageFindMany.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        {
          provide: PrismaService,
          useValue: {
            user: { upsert },
            chatRoom: { upsert: roomUpsert },
            message: { create: messageCreate, findMany: messageFindMany },
          },
        },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('creates or updates the mock user in the database', async () => {
    await service.getOrCreateMockUser('Anna Müller');

    expect(upsert).toHaveBeenCalledWith({
      where: { username: 'anna-muller' },
      create: {
        email: 'anna-muller@mock.chat-up.local',
        username: 'anna-muller',
        firstName: 'Anna',
        LastName: 'Müller',
        status: 'ONLINE',
      },
      update: {
        firstName: 'Anna',
        LastName: 'Müller',
        status: 'ONLINE',
      },
    });
  });

  it('creates or reuses the chat room in the database', async () => {
    await service.getOrCreateChatRoom('raum-1');

    expect(roomUpsert).toHaveBeenCalledWith({
      where: { name: 'raum-1' },
      create: { name: 'raum-1' },
      update: {},
    });
  });

  it('saves a message with its sender and chat room', async () => {
    await service.saveMessage(7, 8, 'Hallo zusammen');

    expect(messageCreate).toHaveBeenCalledWith({
      data: { senderId: 7, chatRoomId: 8, content: 'Hallo zusammen' },
    });
  });

  it('loads the latest 50 messages in chronological order', async () => {
    await service.getRecentMessages(8);

    expect(messageFindMany).toHaveBeenCalledWith({
      where: { chatRoomId: 8 },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        sender: {
          select: { id: true, firstName: true, LastName: true },
        },
      },
    });
  });
});
