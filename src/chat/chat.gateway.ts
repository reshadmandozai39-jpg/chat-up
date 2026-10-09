import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Socket } from 'socket.io';
import { ChatService } from './chat.service.js';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(private readonly chatService: ChatService) {}

  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('joinRoom')
  async handleJoinRoom(
    @MessageBody() requestedRoom: unknown,
    @ConnectedSocket() client: Socket,
  ) {
    const payload = typeof requestedRoom === 'object' && requestedRoom !== null
      ? requestedRoom as { room?: unknown; user?: unknown; email?: unknown }
      : undefined;
    const roomValue = typeof requestedRoom === 'string' ? requestedRoom : payload?.room;
    if (typeof roomValue !== 'string') {
      client.emit('roomError', 'Bitte gib einen gültigen Raumnamen ein.');
      return;
    }

    const room = roomValue.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,40}$/.test(room)) {
      client.emit('roomError', 'Der Raumname darf nur Buchstaben, Zahlen, _ und - enthalten.');
      return;
    }

    const user = typeof payload?.user === 'string' && payload.user.trim()
      ? payload.user.trim()
      : client.data.user || client.id;
    const previousRoom = client.data.room as string | undefined;
    const roomMembers = this.server.sockets.adapter.rooms.get(room) ?? new Set<string>();
    const otherParticipants = new Set(
      [...roomMembers]
        .filter((socketId) => socketId !== client.id)
        .map((socketId) => {
          const member = this.server.sockets.sockets.get(socketId);
          const memberUser = member?.data.user;
          return typeof memberUser === 'string' && memberUser.trim()
            ? memberUser.trim().toLowerCase()
            : `socket:${socketId}`;
        }),
    );
    if (!otherParticipants.has(user.toLowerCase()) && otherParticipants.size >= 2) {
      client.emit('roomError', 'Dieser Raum ist bereits mit zwei Personen belegt.');
      return;
    }

    try {
      const email = typeof payload?.email === 'string' ? payload.email.trim() : undefined;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        client.emit('roomError', 'Bitte gib eine gültige E-Mail-Adresse ein.');
        return;
      }
      const storedUser = await this.chatService.getOrCreateMockUser(user, email);
      const storedRoom = await this.chatService.getOrCreateChatRoom(room);
      client.data.userId = storedUser.id;
      client.data.chatRoomId = storedRoom.id;
    } catch {
      client.emit('roomError', 'User oder Chatraum konnten nicht in der Datenbank gespeichert werden.');
      return;
    }

    if (previousRoom !== room) {
      if (previousRoom) await client.leave(previousRoom);
      await client.join(room);
    }
    client.data.room = room;
    client.data.user = user;
    client.emit('roomJoined', { room, userId: client.data.userId });

    try {
      const messages = await this.chatService.getRecentMessages(client.data.chatRoomId);
      client.emit('messageHistory', messages.map((message) => ({
        messageId: String(message.id),
        userId: message.senderId,
        user: message.sender.LastName === 'Mock'
          ? message.sender.firstName
          : `${message.sender.firstName} ${message.sender.LastName}`,
        message: message.content,
        createdAt: message.createdAt.toISOString(),
      })));
    } catch {
      client.emit('messageHistoryError', 'Der gespeicherte Verlauf konnte nicht geladen werden.');
    }
  }

  @SubscribeMessage('sendMessage')
  async handleMessage(
    @MessageBody() payload: { user?: string; message?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = client.data.room as string | undefined;
    const userId = client.data.userId;
    const chatRoomId = client.data.chatRoomId;
    const message = payload?.message;

    if (
      !room ||
      !Number.isInteger(userId) ||
      !Number.isInteger(chatRoomId) ||
      typeof message !== 'string' ||
      !message.trim()
    ) return;

    let storedMessage;
    try {
      storedMessage = await this.chatService.saveMessage(
        userId,
        chatRoomId,
        message.trim(),
      );
    } catch {
      client.emit('messageError', 'Die Nachricht konnte nicht in der Datenbank gespeichert werden.');
      return;
    }

    this.server.to(room).emit('receivedMessage', {
      messageId: String(storedMessage.id),
      senderId: client.id,
      userId,
      user: client.data.user || client.id,
      message: message.trim(),
      createdAt: storedMessage.createdAt.toISOString(),
    });
  }

  @SubscribeMessage('messageRead')
  handleMessageRead(
    @MessageBody() payload: { messageId?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = client.data.room as string | undefined;
    const messageId = payload?.messageId;

    if (!room || typeof messageId !== 'string' || !messageId) return;

    this.server.to(room).emit('messageRead', {
      messageId,
      readerId: client.id,
    });
  }
}
